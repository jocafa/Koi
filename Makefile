UGLIFY = ./node_modules/uglifiy-js/bin/uglifyjs
VOWS = ./node_modules/vows/bin/vows

all:


test: all
	@$(VOWS)

%.min.js: %.js Makefile
	@rm -f $@
	$(UGLIFY) < $< > $@
