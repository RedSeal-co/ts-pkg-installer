/// <reference path="../typings/bar/bar.d.ts" />
/// <reference path="foo.d.ts" />

import foo = require('foo');

export function secondary(): foo.Foo {
  return new foo.Foo();
}
