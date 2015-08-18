/// <reference path="typings/bluebird/bluebird.d.ts"/>
'use strict';
var myutil = require('./myutil');
var myutil_1 = require('./myutil');
exports.foo = myutil_1.foo;
exports.bar = myutil_1.bar;
function baz() {
    return myutil.foo()
        .then(function () { return myutil.bar(); });
}
exports.baz = baz;
//# sourceMappingURL=public.js.map