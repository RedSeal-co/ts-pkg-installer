///<reference path='../typings/bluebird/bluebird.d.ts'/>
///<reference path="../typings/mkdirp/mkdirp.d.ts"/>
///<reference path='../typings/node/node.d.ts'/>

'use strict';

export import fs = require('fs');
import mkdirp = require('mkdirp');
import P = require('bluebird');

// Typescript 1.5.3 and/or bluebird.d.ts needs assistance inferring the correct overload of fs API.
interface ReadFileFunc {
  (filename: string, encoding: string, callback: (err: any, data: string) => void): void;
}

interface WriteFileFunc {
  (filename: string, data: any, callback: (err: any, result: void) => void): void;
}

export var readFileP = P.promisify(<ReadFileFunc> fs.readFile);
export var writeFileP = P.promisify(<WriteFileFunc> fs.writeFile);


// We must first normalize the fs.exists API to give it the node-like callback signature.
function normalizedExists(file: string, callback: (err: any, exists: boolean) => void): void {
  fs.exists(file, (exists: boolean): void => {
    callback(null, exists);
  });
}

// Next, we wrap the normalized API with Bluebird to make it return a promise.
export var existsP = P.promisify(normalizedExists);

interface MkDirPFunc {
  (dir: string, callback: (err: Error, made: string) => void): void;
}
export var mkdirpP = P.promisify(<MkDirPFunc> mkdirp);

export var realpathP = P.promisify(fs.realpath);
