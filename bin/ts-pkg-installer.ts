// ts-pkg-installer.ts
///<reference path="../typings/commander/commander.d.ts"/>
///<reference path="../typings/bluebird/bluebird.d.ts"/>
///<reference path="../typings/debug/debug.d.ts"/>
///<reference path="../typings/glob/glob.d.ts"/>
///<reference path="../typings/lodash/lodash.d.ts"/>
///<reference path="../typings/node/node.d.ts"/>

///<reference path="./util.ts"/>

'use strict';

declare function require(name: string): any;
require('source-map-support').install();

import _ = require('lodash');
import assert = require('assert');
import commander = require('commander');
import debug = require('debug');
import fs = require('./fs');
import glob = require('glob');
import P = require('bluebird');
import path = require('path');

// There is no DTS for this package, but we will promisify it later.
var readPackageJson = require('read-package-json');

import util = require('./util');

P.longStackTraces();

// Command-line options, describing the structure of options in commander.
class Options {
  configFile: string;
  dryRun: boolean;
  selfInstall: boolean;
  verbose: boolean;

  constructor(options: any = {}) {
    this.configFile = options.configFile || 'tspi.json';
    this.dryRun = options.dryRun || false;
    this.selfInstall = options.selfInstall || false;
    this.verbose = options.verbose || false;
  }
}

var defaultOptions = new Options();

// ## CLI
// Define the CLI.
commander
  .option('-f, --config-file <path>', 'Config file [' + defaultOptions.configFile + ']', defaultOptions.configFile)
  .option('-n, --dry-run', 'Dry run (display what would happen without taking action)')
  .option('-s, --self-install', 'Install in module\'s own directory instead of parent')
  .option('-v, --verbose', 'Verbose logging');

var debugNamespace = 'ts-pkg-installer';
var dlog: debug.Debugger = debug(debugNamespace);

// ## Config
// Configuration data from tspi.json
class Config {

  // Force script to run even if it does not think it should run.
  force: boolean;

  // Path to the NPM package.json config file.
  packageConfig: string;

  // Path to the exported module declaration file.  By default, this is the *.d.ts with the same basename as the "main"
  // JS file, as declared in package config.
  mainDeclaration: string;

  // Path to any secondary declaration files that should be exported alongside mainDeclaration.
  secondaryDeclarations: string[];

  // Disable wrapping of main declaration in its own ambient external module declaration.  This is appropriate for
  // processing declaration files that already contain ambient external module declarations.
  noWrap: boolean;

  // Name of the module as specified in the wrapped declaration file.  By default, this is the name of the NPM package.
  moduleName: string;

  // Typings directory in which our own TSD writes.  Default to 'typings'.
  localTypingsDir: string;

  // Typings directory into which the module declaration file and any dependencies will be written.  By default, this
  // will be ../../typings (or ../../../typings if package name is scoped).
  exportedTypingsDir: string;

  // Subdirectory of typings directory in which our module declaration file is written.  By default, this is the
  // package name.
  typingsSubdir: string;

  // TSD configuration file in the current package.  Defaults to 'tsd.json'.
  localTsdConfig: string;

  // TSD configuration file to export.  Defaults to '../tsd.json' (or '../../tsd.json' if package name is scoped),
  // which should land in the node_modules directory of the depending package.
  exportedTsdConfig: string;

  constructor(config: any = {}) {
    this.force = config.force || false;
    this.packageConfig = config.packageConfig || 'package.json';
    this.mainDeclaration = config.mainDeclaration;
    this.secondaryDeclarations = config.secondaryDeclarations || [];
    this.noWrap = config.noWrap || false;
    this.moduleName = config.moduleName;
    this.localTypingsDir = config.localTypingsDir || 'typings';
    this.exportedTypingsDir = config.exportedTypingsDir;
    this.typingsSubdir = config.typingsSubdir;
    this.localTsdConfig = config.localTsdConfig || 'tsd.json';
    this.exportedTsdConfig = config.exportedTsdConfig;
  }
}

var defaultConfig = new Config();

// ## PackageConfig
// Configuration data from package.json (the part we care about).
class PackageConfig {
  name: string;
  main: string;

  constructor(config: any = {}) {
    this.name = config.name;
    this.main = config.main || 'index.js';
  }
}

// ## readPackageJsonAsync
interface ReadPackageJson {
  (packageFile: string, callback: (err: Error, contents: string) => void): void;
}
var readPackageJsonAsync = P.promisify(<ReadPackageJson>readPackageJson);

// ## mkdirp
// Create a directory, and then dlog the real path created.
function mkdirp(dir: string): P<void> {
  return fs.mkdirpP(dir)
    .then((made: string) => fs.realpathP(dir))
    .then((realpath: string) => { dlog('Created', realpath); });
}

// ## writeFile
// Write a file, and then dlog the real path written.
function writeFile(filePath: string, contents: string): P<void> {
  return fs.writeFileP(filePath, contents)
    .then(() => fs.realpathP(filePath))
    .then((realpath: string) => { dlog('Wrote', realpath); });
}

// ### DeclarationFileState
// Maintain a state machine, separating the file into header and body sections.
enum DeclarationFileState {Header, Body};

// ## TypeScriptPackageInstaller
// Used as the NPM postinstall script, this will do the following:
// - Read configuration from tspi.json (or options.configFile)
// - Wrap the main declaration file
// - Copy the main declaration file to the "typings" directory
class TypeScriptPackageInstaller {

  // Recognize reference path lines that form the header.
  private static referencePathRegex = /^ *\/\/\/ *<reference *path *= *['"](.*)["'] *\/> *$/;

  private options: Options;
  private config: Config;
  private packageConfig: PackageConfig;
  private wrappedMainDeclaration: string;
  private localTsdConfig: util.TsdConfig;
  private exportedTsdConfig: util.TsdConfig;

  // Directory containing the wrapped main declaration file that we export.
  private exportedTypingsSubdir: string;

  constructor (options: Options = defaultOptions) {
    this.options = options;
    this.parseInitOptions();
  }

  // Main entry point to install a TypeScript package as an NPM postinstall script.
  main(): P<void> {
    dlog('main');

    return this.readConfigFile()
      .then(() => {
        if (this.shouldRun()) {
          return this.readPackageConfigFile()
            .then(() => { return this.determineExportedTypingsSubdir(); })
            .then(() => { return this.wrapMainDeclaration(); })
            .then(() => { return this.copyExportedDeclarations(); })
            .then(() => { return this.readLocalTsdConfigFile(); })
            .then(() => { return this.maybeHaulTypings(); });
        } else {
          return P.resolve();
        }
      });
  }

  // Parse the options at initialization.
  private parseInitOptions(): void {
    // Enable verbose output by recreating the dlog function.
    if (this.options.verbose) {
      debug.enable(debugNamespace);
      dlog = debug(debugNamespace);
      dlog('Verbose output');
    }

    // Show all command-line options.
    dlog('Options:\n' + JSON.stringify(this.options, null, 2));

    // Display whether dry run mode is enabled.
    if (this.options.dryRun) {
      dlog('Dry run');
    }
  }

  // Read the configuration file for this utility.
  private readConfigFile(): P<void> {
    var configFile = this.options.configFile;
    var readFromFile: boolean;
    return fs.existsP(configFile)
      .then((exists: boolean): P<string> => {
        if (exists) {
          dlog('Reading config file: ' + configFile);
          readFromFile = true;
          return fs.readFileP(configFile, 'utf8');
        } else {
          dlog('Config file not found: ' + configFile);

          // If they specified a config file, we will fail if it does not exist.
          if (configFile !== defaultOptions.configFile) {
            throw new Error('Config file does not exist: ' + configFile);
          }

          // Otherwise, just use the defaults (as if parsing an empty config file).
          readFromFile = false;
          // Parse an empty JSON object to use the defaults.
          return P.resolve('{}');
        }
      })
      .then((contents: string): void => {
        if (readFromFile) {
          dlog('Read config file: ' + configFile);
          dlog('Config file contents:\n' + contents);
        }
        this.config = new Config(JSON.parse(contents));
      });
  }

  // Determine if we should run based on whether it looks like we're inside a node_modules directory.  This
  // distinguishes between being called in two NPM postinstall cases:
  // - after our package is installed inside a depending package
  // - after our own dependencies are installed
  private shouldRun(): boolean {
    var parentPath: string = path.dirname(process.cwd());
    var parentDir: string = path.basename(parentPath);
    var grandparentDir: string = path.basename(path.dirname(parentPath));
    var should: boolean = this.options.selfInstall || this.config.force || parentDir === 'node_modules' ||
      (parentDir.charAt(0) === '@' && grandparentDir === 'node_modules');
    if (this.options.selfInstall) {
      dlog('Always self-install');
    }
    if (this.config.force) {
      dlog('Forced to run');
    }
    if (!should) {
      dlog('Should not run');
    }
    return should;
  }

  // Read the package configuration.
  private readPackageConfigFile(): P<void> {
    assert(this.config && this.config.packageConfig);
    var packageConfigFile: string = this.config.packageConfig;
    dlog('Reading package config file: ' + packageConfigFile);
    return fs.readFileP(packageConfigFile, 'utf8')
      .then((contents: string): void => {
        dlog('Read package config file: ' + packageConfigFile);
        this.packageConfig = new PackageConfig(JSON.parse(contents));
      })
      .catch((error: any): void => {
        // Create a more user-friendly error message
        throw new Error('Package config file could not be read: ' + packageConfigFile);
      });
  }

  // Determine if the package name is scoped.
  private isPackageScoped(): boolean {
    return this.packageConfig.name.charAt(0) === '@';
  }

  // Determine the appropriate directory in which to export module declaration (*.d.ts) files.
  private exportedTypingsDir(): string {
    return this.config.exportedTypingsDir ||
      (this.options.selfInstall ? 'typings'
       : (this.isPackageScoped() ? path.join('..', '..', '..', 'typings') : path.join('..', '..', 'typings')));
  }

  // Determine the appropriate directory in which to export the TSD config (tsd.json) file.
  private exportedTsdConfigPath(): string {
    return this.config.exportedTsdConfig ||
      (this.options.selfInstall ? path.join('typings', 'tsd.json')
       : (this.isPackageScoped() ? path.join('..', '..', 'tsd.json') : path.join('..', 'tsd.json')));
  }

  // Determine where we will write our main declaration file.
  // - Side effect: Sets `this.config.typingsSubdir`, if not specified in config file
  // - Side effect: Sets `this.exportedTypingsSubdir`.
  private determineExportedTypingsSubdir(): void {
    // Use the package name if no typings subdir specified.
    if (!this.config.typingsSubdir) {
      this.config.typingsSubdir = this.packageConfig.name;
    }

    this.exportedTypingsSubdir = path.join(this.exportedTypingsDir(), this.config.typingsSubdir);
  }

  // Wrap the main declaration file, by default based on the "main" JS file from package.json.
  private wrapMainDeclaration(): P<void> {
    assert(this.config);
    assert(this.config.typingsSubdir);

    // Figure out what the main declaration file is.
    var mainDeclarationFile: string = this.determineMainDeclaration();

    // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
    var mainDeclarationDir: string = this.determineMainDeclarationDir();

    dlog('Reading main declaration file: ' + mainDeclarationFile);
    return fs.readFileP(mainDeclarationFile, 'utf8')
      .then((contents: string): P<string> => {
        dlog('Parsing main declaration file: ' + mainDeclarationFile);
        return this.wrapMainDeclarationContents(contents, mainDeclarationDir);
      })
      .then((wrapped: string): void => {
        dlog('Wrapped main declaration file:\n' + wrapped);
        this.wrappedMainDeclaration = wrapped;
      })
      .catch((error: any): void => {
        // Create a more user-friendly error message
        throw new Error('Main declaration file could not be wrapped: ' + error.toString());
      });
  }

  // Determine what the main declaration file for the package is.  If not configured, it is the *.d.ts with the same
  // basename as the package "main" JS file.
  private determineMainDeclaration(): string {
    assert(this.config);
    assert(this.packageConfig);
    if (this.config.mainDeclaration) {
      return this.config.mainDeclaration;
    } else {
      var mainJS = this.packageConfig.main;
      var mainDTS = mainJS.replace(/\.js$/, '.d.ts');
      return mainDTS;
    }
  }

  // Determine the directory containing the main declaration file.
  private determineMainDeclarationDir(): string {

    // Figure out what the main declaration file is.
    var mainDeclarationFile: string = this.determineMainDeclaration();

    // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
    var mainDeclarationDir: string = path.dirname(path.resolve(mainDeclarationFile));

    return mainDeclarationDir;
  }

  // Wrap the main declaration file whose contents are provided.
  // - *contents*: Contents of the main declaration file (TypeScript *.d.ts file)
  // - *referencePathDir*: Directory to resolve related reference paths.
  private wrapMainDeclarationContents(contents: string, referencePathDir: string): P<string> {
    // Process each line in the main declaration file.
    var lines: string[] = contents.split('\n');

    // Recognize comments that may appear in the header or body.
    var commentRegex = /^ *\/\/.*$/;
    var blankRegex = /^ *$/;

    // Recognize declarations in the body.
    var declarationRegex = /^(export )?(declare )(.*)$/;

    // Maintain a state machine, separating the file into header and body sections.
    var state: DeclarationFileState = DeclarationFileState.Header;

    // We may not be wrapping the main declaration in an ambient external module declaration.
    if (this.config.noWrap) {
      dlog('Main ambient external module declaration disabled');
    }

    var reducer = (wrapped: string[], line: string): string[] => {

      if (state === DeclarationFileState.Header) {
        // See if we have a reference path (which is a form of comment).
        var referencePathMatches: string[] = line.match(TypeScriptPackageInstaller.referencePathRegex);
        var isReferencePath: boolean = referencePathMatches && true;
        if (isReferencePath) {

          // Rewrite the reference path relative to the destination typings directory.
          var referencePath: string = referencePathMatches[1];
          assert(referencePath);
          line = this.rewriteReferencePath(referencePath, referencePathDir);

        } else {
          // See if we have a comment or blank line.
          var isComment: boolean = line.match(commentRegex) && true;
          var isBlank: boolean = !isComment && line.match(blankRegex) && true;

          // Stay in header state if we have a comment or blank line.
          if (! (isComment || isBlank)) {
            // Transitioning out of header state, so emit the module declaration.
            if (!(this.config.noWrap)) {
              wrapped.push(this.moduleDeclaration());
            }
            state = DeclarationFileState.Body;
          }
        }
      }

      if (state === DeclarationFileState.Body && !(this.config.noWrap)) {
        // See if we have a declaration of some sort.
        var declarationMatches: string[] = line.match(declarationRegex);
        var isDeclaration: boolean = declarationMatches && true;
        if (isDeclaration) {
          // Remove the 'declare' keyword, as it is not allowed within a module declaration.
          line = (declarationMatches[1] || '') + declarationMatches[3];
        }
      }

      // Emit the line (but not blank lines).
      if (line !== '') {
        wrapped.push(line);
      }
      return wrapped;
    };

    return P.reduce(lines, reducer, [])
      .then((wrapped: string[]): string => {

        if (!(this.config.noWrap)) {
          // If we're still in the header (i.e. we had no body lines), then emit the module declaration now.
          if (state === DeclarationFileState.Header) {
            wrapped.push(this.moduleDeclaration());
            state = DeclarationFileState.Body;
          }

          // End by closing the module declaration
          wrapped.push('}');
          wrapped.push('');
        }

        return wrapped.join('\n');
      });
  }

  // Rewrite the secondary declaration file whose contents are provided.
  // - *contents*: Contents of the secondary declaration file (TypeScript *.d.ts file)
  // - *referencePathDir*: Directory to resolve related reference paths.
  private rewriteSecondaryDeclarationContents(contents: string, referencePathDir: string): P<string> {
    // Process each line in the main declaration file.
    var lines: string[] = contents.split('\n');

    var reducer = (wrapped: string[], line: string): string[] => {

      // See if we have a reference path.
      var referencePathMatches: string[] = line.match(TypeScriptPackageInstaller.referencePathRegex);
      var isReferencePath: boolean = referencePathMatches && true;
      if (isReferencePath) {

        // Rewrite the reference path relative to the destination typings directory.
        var referencePath: string = referencePathMatches[1];
        assert(referencePath);
        line = this.rewriteReferencePath(referencePath, referencePathDir);
      }

      // Emit the line.
      wrapped.push(line);
      return wrapped;
    };

    return P.reduce(lines, reducer, [])
      .then((wrapped: string[]): string => {
        return wrapped.join('\n');
      });
  }

  // Rewrite the reference path relative to the destination typings directory.
  // - *referencePath*: TypeScript reference path
  // - *dir*: Directory for resolving relative path
  private rewriteReferencePath(referencePath: string, dir: string): string {
    assert(this.config && this.config.typingsSubdir);
    assert(this.config && this.config.localTypingsDir);

    // Determine the rewritten path.
    var newPath: string;

    // If we are referring to a path that is one of the secondary declarations that we are going to copy, then we don't
    // have to modify it.
    if (this.isSecondaryDeclaration(referencePath, dir)) {
      newPath = referencePath;
    } else {

      // Figure out where we are relative to the main declaration dir.
      var mainDeclarationDir: string = this.determineMainDeclarationDir();
      var sourceDir: string = path.relative(mainDeclarationDir, dir);

      // Identify the subdirectory of our local typings directory where we would be, if we were installed in our local
      // typings directory.
      var localTypingsSubdir: string =
        path.resolve(path.join(this.config.localTypingsDir, this.config.typingsSubdir, sourceDir));

      // Figure out what the reference path is.
      var currentPath: string = path.resolve(dir, referencePath);

      // Calculate the path relative to where we would be installed within our local typings directory.
      newPath = path.relative(localTypingsSubdir, currentPath);
    }
    return '/// <reference path="' + newPath + '" />';
  }

  // Check if the reference path refers to one of the secondary declarations.
  // - *referencePath*: TypeScript reference path
  // - *dir*: Directory for resolving relative path
  private isSecondaryDeclaration(referencePath: string, dir: string): boolean {
    assert(this.config);
    assert(_.isArray(this.config.secondaryDeclarations));

    var resolvedReferencePath: string = path.resolve(dir, referencePath);

    // Check if it matches any of the secondary
    var match: string = _.find(this.config.secondaryDeclarations, (secondaryDeclaration: string): boolean => {
      var resolvedSecondaryDeclaration: string = path.resolve(secondaryDeclaration);
      return resolvedReferencePath === resolvedSecondaryDeclaration;
    });
    dlog('Reference path', referencePath, 'matches', match);

    return match ? true : false;
  }

  // Return the TypeScript module declaration statement for this package.
  private moduleDeclaration(): string {
    assert(this.packageConfig);
    // Use the configured module name, defaulting to the package name.
    var moduleName: string = this.config.moduleName || this.packageConfig.name;
    return 'declare module \'' + moduleName + '\' {';
  }

  // Copy exported declarations into typings.
  private copyExportedDeclarations(): P<void> {
    return this.copyMainModuleDeclaration()
      .then(() => this.copySecondaryDeclarations());
  }

  // Copy the wrapped main module declaration into typings.
  private copyMainModuleDeclaration(): P<void> {
    assert(this.config);
    assert(this.exportedTypingsSubdir);
    assert(this.wrappedMainDeclaration);

    // Create the directory.
    dlog('Creating directory for main declaration file: ' + this.exportedTypingsSubdir);
    return this.maybeDo((): P<void> => mkdirp(this.exportedTypingsSubdir))
      .then((): P<void> => {
        // Use the same basename.
        var basename: string = path.basename(this.determineMainDeclaration());
        var mainDeclaration: string = path.join(this.exportedTypingsSubdir, basename);
        dlog('Writing main declaration file: ' + mainDeclaration);
        return this.maybeDo((): P<void> => writeFile(mainDeclaration, this.wrappedMainDeclaration));
      });
  }

  // Copy the secondary declarations (as-is) into typings.
  private copySecondaryDeclarations(): P<void> {
    assert(this.config);
    assert(_.isArray(this.config.secondaryDeclarations));

    var promises: P<void>[] =
      _.map(this.config.secondaryDeclarations,
            (basename: string): P<void> => this.copySecondaryDeclaration(basename));
    return P.all(promises).then(() => { return; });
  }

  // Copy a single secondary declaration (as-is) into typings.
  private copySecondaryDeclaration(sourceFile: string): P<void> {
    // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
    var mainDeclarationDir: string = this.determineMainDeclarationDir();

    // Determine the path relative to the directory containing the main declaration.
    var sourceRelativePath: string = path.relative(mainDeclarationDir, sourceFile);

    // Figure out where it needs to be copied.
    var destinationFile: string = path.join(this.exportedTypingsSubdir, sourceRelativePath);

    // Make sure the directory exists.
    var destinationDir: string = path.dirname(path.resolve(destinationFile));

    // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
    var sourceDeclarationDir: string = path.dirname(path.resolve(sourceFile));

    return this.maybeDo(
      (): P<void> => {
        dlog('Creating directory for secondary declaration file:', destinationDir);
        return mkdirp(destinationDir);
      })
      .then((): P<string> => {
        dlog('Copying secondary declaration file:', destinationFile);
        return fs.readFileP(sourceFile, 'utf8');
      })
      .then((contents: string): P<string> => {
        dlog('Parsing secondary declaration file:', sourceFile);
        return this.rewriteSecondaryDeclarationContents(contents, sourceDeclarationDir);
      })
      .then((wrapped: string): P<void> => {
        dlog('Wrapped secondary declaration file:\n', wrapped);
        return this.maybeDo((): P<void> => writeFile(destinationFile, wrapped));
      })
      .catch((error: any): void => {
        // Create a more user-friendly error message
        throw new Error('Secondary declaration file ' + sourceFile + ' could not be wrapped: ' + error.toString());
      });
  }

  // Read the local TSD configuration.
  private readLocalTsdConfigFile(): P<void> {
    assert(this.config && this.config.localTsdConfig);
    return this.readTsdConfigFile(this.config.localTsdConfig)
      .then((config: util.TsdConfig): void => {
        this.localTsdConfig = config;
      });
  }

  // Read the exported TSD configuration (if any).
  private readExportedTsdConfigFile(): P<void> {
    assert(this.config && this.exportedTsdConfigPath());
    return this.readTsdConfigFile(this.exportedTsdConfigPath())
      .then((config: util.TsdConfig): void => {
        this.exportedTsdConfig = config;
      });
  }

  // Read the specified TSD configuration.  Return null if file does not exist.
  private readTsdConfigFile(path: string): P<util.TsdConfig> {
    dlog('Reading TSD config file: ' + path);
    return fs.readFileP(path, 'utf8')
      .then((contents: string): util.TsdConfig => {
        dlog('Read TSD config file: ' + path);
        return new util.TsdConfig(JSON.parse(contents));
      })
      .catch((error: any): util.TsdConfig => {
        // It's OK if the file isn't there.
        dlog('Ignoring error reading TSD config file: ' + path + ': ' + error.toString());
        return <util.TsdConfig> null;
      });
  }

  // Incorporate typings from our own dependencies (if any).
  private maybeHaulTypings(): P<void> {
    // If we have no typings, we don't have anything to do.
    if (!this.localTsdConfig) {
      dlog('No TSD typings to haul');
      return P.resolve();
    } else {
      return this.readExportedTsdConfigFile()
        .then((): void => {
          this.haulTypings();
        });
    }
  }

  // Incorporate typings from our own dependencies.
  private haulTypings(): P<void> {
    assert(this.localTsdConfig);
    // If we have no existing exported typings, we can trivially export ours.
    if (!this.exportedTsdConfig) {
      dlog('No existing exported TSD typings');
      this.exportedTsdConfig = this.localTsdConfig;

      // We do have to change the path to point to the place where we are exporting the typings.
      var tsdConfigDir: string = path.dirname(this.exportedTsdConfigPath());
      var typingsPath: string = path.relative(tsdConfigDir, this.exportedTypingsDir());
      dlog('Configured TSD typings path: ' + typingsPath);
      this.exportedTsdConfig.path = typingsPath;

    } else {

      dlog('Combining with existing exported TSD typings');
      this.exportedTsdConfig.incorporate(this.localTsdConfig);
    }

    // Write the resulting file.
    var contents: string = JSON.stringify(this.exportedTsdConfig, null, 2) + '\n';
    dlog('Combined TSD typings:\n' + contents);
    return this.maybeDo((): P<void> => writeFile(this.exportedTsdConfigPath(), contents));
  }

  // Allow conditional execution based on dry run mode.
  private maybeDo(action: () => P<void>): P<void> {
    if (!this.options.dryRun) {
      return action();
    } else {
      return P.resolve();
    }
  }
}

// Set the version of this tool based on package.json.
function setVersion(): P<void> {
  var packageJsonFile: string = path.join(__dirname, '..', 'package.json');
  return readPackageJsonAsync(packageJsonFile)
    .then((packageJson: any): void => {
      var version: string = packageJson.version;
      dlog('Version:', version);
      commander.version(version);
      return;
    });
}

// Determine the version before parsing command-line.
setVersion()
  .then((): void => {

    // Parse command line arguments.
    commander.parse(process.argv);
    dlog('commander:\n' + JSON.stringify(commander, null, 2));

    if (commander.args.length !== 0) {
      process.stderr.write('Unexpected arguments.\n');
      commander.help();
    } else {
      // Retrieve the options (which are stored as undeclared members of the command object).
      var options = new Options(commander);
      var mgr = new TypeScriptPackageInstaller(options);
      mgr.main()
        .catch((err: Error) => {
          dlog(err.toString());
          process.stderr.write(__filename + ': ' + err.toString() + '\n');
          process.exit(1);
        });
    }
  });
