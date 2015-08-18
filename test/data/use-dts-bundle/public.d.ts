/// <reference path="typings/bluebird/bluebird.d.ts" />
import P = require('bluebird');
export { foo, bar } from './myutil';
export declare function baz(): P<void>;
