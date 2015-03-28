/// <reference path="../typings/bar/bar.d.ts" />
/// <reference path="foo.d.ts" />
var foo = require('foo');
function secondary() {
    return new foo.Foo();
}
exports.secondary = secondary;
//# sourceMappingURL=util.js.map