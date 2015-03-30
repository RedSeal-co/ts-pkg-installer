/// <reference path="foo.d.ts"/>
/// <reference path="typings/bluebird/bluebird.d.ts"/>

declare module 'no-wrap' {
  import _bar = require('__no-wrap/bar');
  import BluePromise = require('bluebird');
  module NoWrap {
    function main(): void;
  }
  export = NoWrap;
}

declare module '__no-wrap/bar' {
  export = bar;
  function bar(): void;
}
