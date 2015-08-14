///<reference path='../typings/bluebird/bluebird.d.ts'/>
///<reference path="../typings/mkdirp/mkdirp.d.ts"/>
///<reference path='../typings/node/node.d.ts'/>
'use strict';
exports.fs = require('fs');
var mkdirp = require('mkdirp');
var P = require('bluebird');
exports.readFileP = P.promisify(exports.fs.readFile);
exports.writeFileP = P.promisify(exports.fs.writeFile);
// We must first normalize the fs.exists API to give it the node-like callback signature.
function normalizedExists(file, callback) {
    exports.fs.exists(file, function (exists) {
        callback(null, exists);
    });
}
// Next, we wrap the normalized API with Bluebird to make it return a promise.
exports.existsP = P.promisify(normalizedExists);
exports.mkdirpP = P.promisify(mkdirp);
exports.realpathP = P.promisify(exports.fs.realpath);
//# sourceMappingURL=fs.js.map