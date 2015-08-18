// ts-pkg-installer.ts
///<reference path="../typings/commander/commander.d.ts"/>
///<reference path="../typings/bluebird/bluebird.d.ts"/>
///<reference path="../typings/debug/debug.d.ts"/>
///<reference path="../typings/glob/glob.d.ts"/>
///<reference path="../typings/lodash/lodash.d.ts"/>
///<reference path="../typings/node/node.d.ts"/>
///<reference path="./util.ts"/>
'use strict';
require('source-map-support').install();
var _ = require('lodash');
var assert = require('assert');
var commander = require('commander');
var debug = require('debug');
var fs = require('./fs');
var P = require('bluebird');
var path = require('path');
// There is no DTS for this package, but we will promisify it later.
var readPackageJson = require('read-package-json');
var util = require('./util');
P.longStackTraces();
// Command-line options, describing the structure of options in commander.
var Options = (function () {
    function Options(options) {
        if (options === void 0) { options = {}; }
        this.configFile = options.configFile || 'tspi.json';
        this.dryRun = options.dryRun || false;
        this.selfInstall = options.selfInstall || false;
        this.verbose = options.verbose || false;
    }
    return Options;
})();
var defaultOptions = new Options();
// ## CLI
// Define the CLI.
commander
    .option('-f, --config-file <path>', 'Config file [' + defaultOptions.configFile + ']', defaultOptions.configFile)
    .option('-n, --dry-run', 'Dry run (display what would happen without taking action)')
    .option('-s, --self-install', 'Install in module\'s own directory instead of parent')
    .option('-v, --verbose', 'Verbose logging');
var debugNamespace = 'ts-pkg-installer';
var dlog = debug(debugNamespace);
// ## Config
// Configuration data from tspi.json
var Config = (function () {
    function Config(config) {
        if (config === void 0) { config = {}; }
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
    return Config;
})();
var defaultConfig = new Config();
// ## PackageConfig
// Configuration data from package.json (the part we care about).
var PackageConfig = (function () {
    function PackageConfig(config) {
        if (config === void 0) { config = {}; }
        this.name = config.name;
        this.main = config.main || 'index.js';
    }
    return PackageConfig;
})();
var readPackageJsonAsync = P.promisify(readPackageJson);
// ## mkdirp
// Create a directory, and then dlog the real path created.
function mkdirp(dir) {
    return fs.mkdirpP(dir)
        .then(function (made) { return fs.realpathP(dir); })
        .then(function (realpath) { dlog('Created', realpath); });
}
// ## writeFile
// Write a file, and then dlog the real path written.
function writeFile(filePath, contents) {
    return fs.writeFileP(filePath, contents)
        .then(function () { return fs.realpathP(filePath); })
        .then(function (realpath) { dlog('Wrote', realpath); });
}
// ### DeclarationFileState
// Maintain a state machine, separating the file into header and body sections.
var DeclarationFileState;
(function (DeclarationFileState) {
    DeclarationFileState[DeclarationFileState["Header"] = 0] = "Header";
    DeclarationFileState[DeclarationFileState["Body"] = 1] = "Body";
})(DeclarationFileState || (DeclarationFileState = {}));
;
// ## TypeScriptPackageInstaller
// Used as the NPM postinstall script, this will do the following:
// - Read configuration from tspi.json (or options.configFile)
// - Wrap the main declaration file
// - Copy the main declaration file to the "typings" directory
var TypeScriptPackageInstaller = (function () {
    function TypeScriptPackageInstaller(options) {
        if (options === void 0) { options = defaultOptions; }
        this.options = options;
        this.parseInitOptions();
    }
    // Main entry point to install a TypeScript package as an NPM postinstall script.
    TypeScriptPackageInstaller.prototype.main = function () {
        var _this = this;
        dlog('main');
        return this.readConfigFile()
            .then(function () {
            if (_this.shouldRun()) {
                return _this.readPackageConfigFile()
                    .then(function () { return _this.determineExportedTypingsSubdir(); })
                    .then(function () { return _this.wrapMainDeclaration(); })
                    .then(function () { return _this.copyExportedDeclarations(); })
                    .then(function () { return _this.readLocalTsdConfigFile(); })
                    .then(function () { return _this.maybeHaulTypings(); });
            }
            else {
                return P.resolve();
            }
        });
    };
    // Parse the options at initialization.
    TypeScriptPackageInstaller.prototype.parseInitOptions = function () {
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
    };
    // Read the configuration file for this utility.
    TypeScriptPackageInstaller.prototype.readConfigFile = function () {
        var _this = this;
        var configFile = this.options.configFile;
        var readFromFile;
        return fs.existsP(configFile)
            .then(function (exists) {
            if (exists) {
                dlog('Reading config file: ' + configFile);
                readFromFile = true;
                return fs.readFileP(configFile, 'utf8');
            }
            else {
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
            .then(function (contents) {
            if (readFromFile) {
                dlog('Read config file: ' + configFile);
                dlog('Config file contents:\n' + contents);
            }
            _this.config = new Config(JSON.parse(contents));
        });
    };
    // Determine if we should run based on whether it looks like we're inside a node_modules directory.  This
    // distinguishes between being called in two NPM postinstall cases:
    // - after our package is installed inside a depending package
    // - after our own dependencies are installed
    TypeScriptPackageInstaller.prototype.shouldRun = function () {
        var parentPath = path.dirname(process.cwd());
        var parentDir = path.basename(parentPath);
        var grandparentDir = path.basename(path.dirname(parentPath));
        var should = this.options.selfInstall || this.config.force || parentDir === 'node_modules' ||
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
    };
    // Read the package configuration.
    TypeScriptPackageInstaller.prototype.readPackageConfigFile = function () {
        var _this = this;
        assert(this.config && this.config.packageConfig);
        var packageConfigFile = this.config.packageConfig;
        dlog('Reading package config file: ' + packageConfigFile);
        return fs.readFileP(packageConfigFile, 'utf8')
            .then(function (contents) {
            dlog('Read package config file: ' + packageConfigFile);
            _this.packageConfig = new PackageConfig(JSON.parse(contents));
        })
            .catch(function (error) {
            // Create a more user-friendly error message
            throw new Error('Package config file could not be read: ' + packageConfigFile);
        });
    };
    // Determine if the package name is scoped.
    TypeScriptPackageInstaller.prototype.isPackageScoped = function () {
        return this.packageConfig.name.charAt(0) === '@';
    };
    // Determine the appropriate directory in which to export module declaration (*.d.ts) files.
    TypeScriptPackageInstaller.prototype.exportedTypingsDir = function () {
        return this.config.exportedTypingsDir ||
            (this.options.selfInstall ? 'typings'
                : (this.isPackageScoped() ? path.join('..', '..', '..', 'typings') : path.join('..', '..', 'typings')));
    };
    // Determine the appropriate directory in which to export the TSD config (tsd.json) file.
    TypeScriptPackageInstaller.prototype.exportedTsdConfigPath = function () {
        return this.config.exportedTsdConfig ||
            (this.options.selfInstall ? path.join('typings', 'tsd.json')
                : (this.isPackageScoped() ? path.join('..', '..', 'tsd.json') : path.join('..', 'tsd.json')));
    };
    // Determine where we will write our main declaration file.
    // - Side effect: Sets `this.config.typingsSubdir`, if not specified in config file
    // - Side effect: Sets `this.exportedTypingsSubdir`.
    TypeScriptPackageInstaller.prototype.determineExportedTypingsSubdir = function () {
        // Use the package name if no typings subdir specified.
        if (!this.config.typingsSubdir) {
            this.config.typingsSubdir = this.packageConfig.name;
        }
        this.exportedTypingsSubdir = path.join(this.exportedTypingsDir(), this.config.typingsSubdir);
    };
    // Wrap the main declaration file, by default based on the "main" JS file from package.json.
    TypeScriptPackageInstaller.prototype.wrapMainDeclaration = function () {
        var _this = this;
        assert(this.config);
        assert(this.config.typingsSubdir);
        // Figure out what the main declaration file is.
        var mainDeclarationFile = this.determineMainDeclaration();
        // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
        var mainDeclarationDir = this.determineMainDeclarationDir();
        dlog('Reading main declaration file: ' + mainDeclarationFile);
        return fs.readFileP(mainDeclarationFile, 'utf8')
            .then(function (contents) {
            dlog('Parsing main declaration file: ' + mainDeclarationFile);
            return _this.wrapMainDeclarationContents(contents, mainDeclarationDir);
        })
            .then(function (wrapped) {
            dlog('Wrapped main declaration file:\n' + wrapped);
            _this.wrappedMainDeclaration = wrapped;
        })
            .catch(function (error) {
            // Create a more user-friendly error message
            throw new Error('Main declaration file could not be wrapped: ' + error.toString());
        });
    };
    // Determine what the main declaration file for the package is.  If not configured, it is the *.d.ts with the same
    // basename as the package "main" JS file.
    TypeScriptPackageInstaller.prototype.determineMainDeclaration = function () {
        assert(this.config);
        assert(this.packageConfig);
        if (this.config.mainDeclaration) {
            return this.config.mainDeclaration;
        }
        else {
            var mainJS = this.packageConfig.main;
            var mainDTS = mainJS.replace(/\.js$/, '.d.ts');
            return mainDTS;
        }
    };
    // Determine the directory containing the main declaration file.
    TypeScriptPackageInstaller.prototype.determineMainDeclarationDir = function () {
        // Figure out what the main declaration file is.
        var mainDeclarationFile = this.determineMainDeclaration();
        // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
        var mainDeclarationDir = path.dirname(path.resolve(mainDeclarationFile));
        return mainDeclarationDir;
    };
    // Wrap the main declaration file whose contents are provided.
    // - *contents*: Contents of the main declaration file (TypeScript *.d.ts file)
    // - *referencePathDir*: Directory to resolve related reference paths.
    TypeScriptPackageInstaller.prototype.wrapMainDeclarationContents = function (contents, referencePathDir) {
        var _this = this;
        // Process each line in the main declaration file.
        var lines = contents.split('\n');
        // Recognize comments that may appear in the header or body.
        var commentRegex = /^ *\/\/.*$/;
        var blankRegex = /^ *$/;
        // Recognize declarations in the body.
        var declarationRegex = /^(export )?(declare )(.*)$/;
        // Maintain a state machine, separating the file into header and body sections.
        var state = DeclarationFileState.Header;
        // We may not be wrapping the main declaration in an ambient external module declaration.
        if (this.config.noWrap) {
            dlog('Main ambient external module declaration disabled');
        }
        // By default, we look for reference paths explicitly stated, but can switch to "dts-bundle" mode.
        var referencePathRegex = TypeScriptPackageInstaller.referencePathRegex;
        var reducer = function (wrapped, line) {
            if (state === DeclarationFileState.Header) {
                // See if we have one of the dts-bundle header lines, and switch to looking for those comments if we do.
                if (_this.isDtsBundleHeader(line)) {
                    referencePathRegex = TypeScriptPackageInstaller.dtsBundleReferencePathRegex;
                }
                else {
                    // See if we have a reference path (which is a form of comment).
                    var referencePathMatches = line.match(referencePathRegex);
                    var isReferencePath = referencePathMatches && true;
                    if (isReferencePath) {
                        // Rewrite the reference path relative to the destination typings directory.
                        var referencePath = referencePathMatches[1];
                        assert(referencePath);
                        line = _this.rewriteReferencePath(referencePath, referencePathDir);
                    }
                    else {
                        // See if we have a comment or blank line.
                        var isComment = line.match(commentRegex) && true;
                        var isBlank = !isComment && line.match(blankRegex) && true;
                        // Stay in header state if we have a comment or blank line.
                        if (!(isComment || isBlank)) {
                            // Transitioning out of header state, so emit the module declaration.
                            if (!(_this.config.noWrap)) {
                                wrapped.push(_this.moduleDeclaration());
                            }
                            state = DeclarationFileState.Body;
                        }
                    }
                }
            }
            if (state === DeclarationFileState.Body && !(_this.config.noWrap)) {
                // See if we have a declaration of some sort.
                var declarationMatches = line.match(declarationRegex);
                var isDeclaration = declarationMatches && true;
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
            .then(function (wrapped) {
            if (!(_this.config.noWrap)) {
                // If we're still in the header (i.e. we had no body lines), then emit the module declaration now.
                if (state === DeclarationFileState.Header) {
                    wrapped.push(_this.moduleDeclaration());
                    state = DeclarationFileState.Body;
                }
                // End by closing the module declaration
                wrapped.push('}');
                wrapped.push('');
            }
            return wrapped.join('\n');
        });
    };
    // Check if the line looks like one of the header lines that dts-bundle generates.
    TypeScriptPackageInstaller.prototype.isDtsBundleHeader = function (line) {
        return (line.match(TypeScriptPackageInstaller.dtsBundleHeader1Regex) ||
            line.match(TypeScriptPackageInstaller.dtsBundleHeader2Regex))
            && true;
    };
    // Rewrite the secondary declaration file whose contents are provided.
    // - *contents*: Contents of the secondary declaration file (TypeScript *.d.ts file)
    // - *referencePathDir*: Directory to resolve related reference paths.
    TypeScriptPackageInstaller.prototype.rewriteSecondaryDeclarationContents = function (contents, referencePathDir) {
        var _this = this;
        // Process each line in the main declaration file.
        var lines = contents.split('\n');
        var reducer = function (wrapped, line) {
            // See if we have a reference path.
            var referencePathMatches = line.match(TypeScriptPackageInstaller.referencePathRegex);
            var isReferencePath = referencePathMatches && true;
            if (isReferencePath) {
                // Rewrite the reference path relative to the destination typings directory.
                var referencePath = referencePathMatches[1];
                assert(referencePath);
                line = _this.rewriteReferencePath(referencePath, referencePathDir);
            }
            // Emit the line.
            wrapped.push(line);
            return wrapped;
        };
        return P.reduce(lines, reducer, [])
            .then(function (wrapped) {
            return wrapped.join('\n');
        });
    };
    // Rewrite the reference path relative to the destination typings directory.
    // - *referencePath*: TypeScript reference path
    // - *dir*: Directory for resolving relative path
    TypeScriptPackageInstaller.prototype.rewriteReferencePath = function (referencePath, dir) {
        assert(this.config && this.config.typingsSubdir);
        assert(this.config && this.config.localTypingsDir);
        // Determine the rewritten path.
        var newPath;
        // If we are referring to a path that is one of the secondary declarations that we are going to copy, then we don't
        // have to modify it.
        if (this.isSecondaryDeclaration(referencePath, dir)) {
            newPath = referencePath;
        }
        else {
            // Figure out where we are relative to the main declaration dir.
            var mainDeclarationDir = this.determineMainDeclarationDir();
            var sourceDir = path.relative(mainDeclarationDir, dir);
            // Identify the subdirectory of our local typings directory where we would be, if we were installed in our local
            // typings directory.
            var localTypingsSubdir = path.resolve(path.join(this.config.localTypingsDir, this.config.typingsSubdir, sourceDir));
            // Figure out what the reference path is.
            var currentPath = path.resolve(dir, referencePath);
            // Calculate the path relative to where we would be installed within our local typings directory.
            newPath = path.relative(localTypingsSubdir, currentPath);
        }
        return '/// <reference path="' + newPath + '" />';
    };
    // Check if the reference path refers to one of the secondary declarations.
    // - *referencePath*: TypeScript reference path
    // - *dir*: Directory for resolving relative path
    TypeScriptPackageInstaller.prototype.isSecondaryDeclaration = function (referencePath, dir) {
        assert(this.config);
        assert(_.isArray(this.config.secondaryDeclarations));
        var resolvedReferencePath = path.resolve(dir, referencePath);
        // Check if it matches any of the secondary
        var match = _.find(this.config.secondaryDeclarations, function (secondaryDeclaration) {
            var resolvedSecondaryDeclaration = path.resolve(secondaryDeclaration);
            return resolvedReferencePath === resolvedSecondaryDeclaration;
        });
        dlog('Reference path', referencePath, 'matches', match);
        return match ? true : false;
    };
    // Return the TypeScript module declaration statement for this package.
    TypeScriptPackageInstaller.prototype.moduleDeclaration = function () {
        assert(this.packageConfig);
        // Use the configured module name, defaulting to the package name.
        var moduleName = this.config.moduleName || this.packageConfig.name;
        return 'declare module \'' + moduleName + '\' {';
    };
    // Copy exported declarations into typings.
    TypeScriptPackageInstaller.prototype.copyExportedDeclarations = function () {
        var _this = this;
        return this.copyMainModuleDeclaration()
            .then(function () { return _this.copySecondaryDeclarations(); });
    };
    // Copy the wrapped main module declaration into typings.
    TypeScriptPackageInstaller.prototype.copyMainModuleDeclaration = function () {
        var _this = this;
        assert(this.config);
        assert(this.exportedTypingsSubdir);
        assert(this.wrappedMainDeclaration);
        // Create the directory.
        dlog('Creating directory for main declaration file: ' + this.exportedTypingsSubdir);
        return this.maybeDo(function () { return mkdirp(_this.exportedTypingsSubdir); })
            .then(function () {
            // Use the same basename.
            var basename = path.basename(_this.determineMainDeclaration());
            var mainDeclaration = path.join(_this.exportedTypingsSubdir, basename);
            dlog('Writing main declaration file: ' + mainDeclaration);
            return _this.maybeDo(function () { return writeFile(mainDeclaration, _this.wrappedMainDeclaration); });
        });
    };
    // Copy the secondary declarations (as-is) into typings.
    TypeScriptPackageInstaller.prototype.copySecondaryDeclarations = function () {
        var _this = this;
        assert(this.config);
        assert(_.isArray(this.config.secondaryDeclarations));
        var promises = _.map(this.config.secondaryDeclarations, function (basename) { return _this.copySecondaryDeclaration(basename); });
        return P.all(promises).then(function () { return; });
    };
    // Copy a single secondary declaration (as-is) into typings.
    TypeScriptPackageInstaller.prototype.copySecondaryDeclaration = function (sourceFile) {
        var _this = this;
        // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
        var mainDeclarationDir = this.determineMainDeclarationDir();
        // Determine the path relative to the directory containing the main declaration.
        var sourceRelativePath = path.relative(mainDeclarationDir, sourceFile);
        // Figure out where it needs to be copied.
        var destinationFile = path.join(this.exportedTypingsSubdir, sourceRelativePath);
        // Make sure the directory exists.
        var destinationDir = path.dirname(path.resolve(destinationFile));
        // Determine the directory containing the file, so that we will be able to resolve relative reference paths.
        var sourceDeclarationDir = path.dirname(path.resolve(sourceFile));
        return this.maybeDo(function () {
            dlog('Creating directory for secondary declaration file:', destinationDir);
            return mkdirp(destinationDir);
        })
            .then(function () {
            dlog('Copying secondary declaration file:', destinationFile);
            return fs.readFileP(sourceFile, 'utf8');
        })
            .then(function (contents) {
            dlog('Parsing secondary declaration file:', sourceFile);
            return _this.rewriteSecondaryDeclarationContents(contents, sourceDeclarationDir);
        })
            .then(function (wrapped) {
            dlog('Wrapped secondary declaration file:\n', wrapped);
            return _this.maybeDo(function () { return writeFile(destinationFile, wrapped); });
        })
            .catch(function (error) {
            // Create a more user-friendly error message
            throw new Error('Secondary declaration file ' + sourceFile + ' could not be wrapped: ' + error.toString());
        });
    };
    // Read the local TSD configuration.
    TypeScriptPackageInstaller.prototype.readLocalTsdConfigFile = function () {
        var _this = this;
        assert(this.config && this.config.localTsdConfig);
        return this.readTsdConfigFile(this.config.localTsdConfig)
            .then(function (config) {
            _this.localTsdConfig = config;
        });
    };
    // Read the exported TSD configuration (if any).
    TypeScriptPackageInstaller.prototype.readExportedTsdConfigFile = function () {
        var _this = this;
        assert(this.config && this.exportedTsdConfigPath());
        return this.readTsdConfigFile(this.exportedTsdConfigPath())
            .then(function (config) {
            _this.exportedTsdConfig = config;
        });
    };
    // Read the specified TSD configuration.  Return null if file does not exist.
    TypeScriptPackageInstaller.prototype.readTsdConfigFile = function (path) {
        dlog('Reading TSD config file: ' + path);
        return fs.readFileP(path, 'utf8')
            .then(function (contents) {
            dlog('Read TSD config file: ' + path);
            return new util.TsdConfig(JSON.parse(contents));
        })
            .catch(function (error) {
            // It's OK if the file isn't there.
            dlog('Ignoring error reading TSD config file: ' + path + ': ' + error.toString());
            return null;
        });
    };
    // Incorporate typings from our own dependencies (if any).
    TypeScriptPackageInstaller.prototype.maybeHaulTypings = function () {
        var _this = this;
        // If we have no typings, we don't have anything to do.
        if (!this.localTsdConfig) {
            dlog('No TSD typings to haul');
            return P.resolve();
        }
        else {
            return this.readExportedTsdConfigFile()
                .then(function () {
                _this.haulTypings();
            });
        }
    };
    // Incorporate typings from our own dependencies.
    TypeScriptPackageInstaller.prototype.haulTypings = function () {
        var _this = this;
        assert(this.localTsdConfig);
        // If we have no existing exported typings, we can trivially export ours.
        if (!this.exportedTsdConfig) {
            dlog('No existing exported TSD typings');
            this.exportedTsdConfig = this.localTsdConfig;
            // We do have to change the path to point to the place where we are exporting the typings.
            var tsdConfigDir = path.dirname(this.exportedTsdConfigPath());
            var typingsPath = path.relative(tsdConfigDir, this.exportedTypingsDir());
            dlog('Configured TSD typings path: ' + typingsPath);
            this.exportedTsdConfig.path = typingsPath;
        }
        else {
            dlog('Combining with existing exported TSD typings');
            this.exportedTsdConfig.incorporate(this.localTsdConfig);
        }
        // Write the resulting file.
        var contents = JSON.stringify(this.exportedTsdConfig, null, 2) + '\n';
        dlog('Combined TSD typings:\n' + contents);
        return this.maybeDo(function () { return writeFile(_this.exportedTsdConfigPath(), contents); });
    };
    // Allow conditional execution based on dry run mode.
    TypeScriptPackageInstaller.prototype.maybeDo = function (action) {
        if (!this.options.dryRun) {
            return action();
        }
        else {
            return P.resolve();
        }
    };
    // Recognize reference path lines that form the header.
    TypeScriptPackageInstaller.referencePathRegex = /^ *\/\/\/ *<reference *path *= *['"](.*)["'] *\/> *$/;
    // Recognize the parts of a declaration generated by dts-bundle.
    TypeScriptPackageInstaller.dtsBundleHeader1Regex = /^\/\/ Generated by dts-bundle .*/;
    TypeScriptPackageInstaller.dtsBundleHeader2Regex = /^\/\/ Dependencies for this module:.*/;
    TypeScriptPackageInstaller.dtsBundleReferencePathRegex = /\/\/ +(.*)/;
    return TypeScriptPackageInstaller;
})();
// Set the version of this tool based on package.json.
function setVersion() {
    var packageJsonFile = path.join(__dirname, '..', 'package.json');
    return readPackageJsonAsync(packageJsonFile)
        .then(function (packageJson) {
        var version = packageJson.version;
        dlog('Version:', version);
        commander.version(version);
        return;
    });
}
// Determine the version before parsing command-line.
setVersion()
    .then(function () {
    // Parse command line arguments.
    commander.parse(process.argv);
    dlog('commander:\n' + JSON.stringify(commander, null, 2));
    if (commander.args.length !== 0) {
        process.stderr.write('Unexpected arguments.\n');
        commander.help();
    }
    else {
        // Retrieve the options (which are stored as undeclared members of the command object).
        var options = new Options(commander);
        var mgr = new TypeScriptPackageInstaller(options);
        mgr.main()
            .catch(function (err) {
            dlog(err.toString());
            process.stderr.write(__filename + ': ' + err.toString() + '\n');
            process.exit(1);
        });
    }
});
//# sourceMappingURL=ts-pkg-installer.js.map