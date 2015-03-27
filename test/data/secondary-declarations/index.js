/// <reference path="./lib/foo.d.ts"/>
exports.util = require('./lib/util');
var foo = require('foo');
exports.Foo = foo.Foo;
function makeFoo() {
    return new exports.Foo();
}
exports.makeFoo = makeFoo;
//# sourceMappingURL=index.js.map