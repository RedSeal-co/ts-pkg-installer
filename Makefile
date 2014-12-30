.PHONY: install install-npm install-tsd lint test unittest cucumber compile
.PHONY: clean clean-obj clean-tsd clean-npm

default: test

clean: clean-obj clean-tsd clean-npm

clean-tsd:
	rm -rf typings

clean-npm:
	rm -rf node_modules

clean-obj:
	rm -f $(TS_OBJ)

install:
	$(MAKE) install-npm
	$(MAKE) install-tsd

install-npm:
	npm install

TSD=./node_modules/.bin/tsd

install-tsd:
	$(TSD) reinstall

lint:
	ls $(TS_SRC) $(TSD_SRC) | xargs -n1 node_modules/.bin/tslint --config tslint.json --file

documentation :
	node_modules/.bin/groc --except "**/node_modules/**" --except "**/typings/**" "**/*.ts" README.md

test: unittest cucumber

unittest:
	echo "No cucumber tests defined for this module."

cucumber: lint compile
	node_modules/.bin/cucumber-js --tags '~@todo'

TSD_SRC=$(wildcard lib/export/*.d.ts)
TS_SRC=$(filter-out %.d.ts,$(wildcard bin/*.ts test/*.ts features/step_definitions/*.ts))
TS_OBJ=$(patsubst %.ts,%.js,$(TS_SRC))
TSC=./node_modules/.bin/tsc
TSC_OPTS=--module commonjs --target ES5 --sourceMap

compile: $(TS_OBJ)

%.js: %.ts
	$(TSC) $(TSC_OPTS) $<
	stat $@ > /dev/null
