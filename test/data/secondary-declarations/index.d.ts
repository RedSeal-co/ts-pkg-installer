/// <reference path="lib/foo.d.ts" />
export import util = require('./lib/util');
import foo = require('foo');
export import Foo = foo.Foo;
export declare function makeFoo(): Foo;
