/// <reference path="typings/bluebird/bluebird.d.ts"/>

'use strict';

import myutil = require('./myutil');
import P = require('bluebird');

export {
  foo,
  bar
} from './myutil';

export function baz(): P<void> {
  return myutil.foo()
    .then(() => myutil.bar());
}
