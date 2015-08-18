/// <reference path="typings/bluebird/bluebird.d.ts"/>
'use strict';
var P = require('bluebird');
function foo() {
    return P.resolve();
}
exports.foo = foo;
function bar() {
    return P.resolve();
}
exports.bar = bar;
//# sourceMappingURL=myutil.js.map