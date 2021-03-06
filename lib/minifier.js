var Minifier
  , _ = {
      each: require('lodash.foreach')
    , defaults: require('lodash.defaults')
    , bind: require('lodash.bind')
    }
  , fs = require('fs')
  , path = require('path')
  , tmp = require('tmp')
  , concat = require('concat-stream')
  , through = require('through')
  , uglify = require('uglify-js')
  , SM = require('source-map')
  , convertSM = require('convert-source-map')
  , SMConsumer = SM.SourceMapConsumer
  , SMGenerator = SM.SourceMapGenerator;

Minifier = function (opts) {
  /*
  * Handle options/defaults
  */

  opts = opts || {};

  var defaults = {
        minify: true
      , source: 'bundle.js'
      , map: 'bundle.map'
      , compressPath: function (filePath) {
          // noop
          return filePath;
        }
      }
  , compressTarget;

  this.opts = _.defaults(opts, defaults);

  /* Turn a string compressPath into a function */
  if(typeof this.opts.compressPath == 'string') {
    compressTarget = this.opts.compressPath;

    this.opts.compressPath = function (p) {
      return path.relative(compressTarget, p);
    }
  }

  /*
  * Instance variables
  */
  this.registry = {}; // Keep source maps and code by file

  /**
  * Browserify runs transforms with a different context
  * but we always want to refer to ourselves
  */
  this.transformer = _.bind(this.transformer, this);

  return this;
};


/*
* Registers maps and code by file
*/
Minifier.prototype.registerMap = function (file, code, map) {
  this.registry[file] = {code:code, map:map};
};

/*
* Gets map by file
*/
Minifier.prototype.mapForFile = function (file) {
  if(!this.fileExists(file)) {
    throw new Error('ENOFILE');
  }

  return this.registry[file].map;
};

/*
* Gets code by file
*/
Minifier.prototype.codeForFile = function (file) {
  if(!this.fileExists(file)) {
    throw new Error('ENOFILE');
  }

  return this.registry[file].code;
};

Minifier.prototype.fileExists = function (file) {
  return (this.registry[file] != null);
}

/*
* Compresses code before Browserify touches it
* Does nothing if minify is false
*/
Minifier.prototype.transformer = function (file) {
  var self = this
    , buffs = []
    , write
    , end
    , throughStream;

  //Normalize the path separators to match what Browserify stores in the original Source Map
  file = file.replace(new RegExp('\\' + path.sep, 'g'), '/');

  write = function (data) {
    if(self.opts.minify) {
      buffs.push(data);
    }
    else {
      this.queue(data);
    }
  }

  end = function () {
    var thisStream = this
      , unminCode = buffs.join('')
      , originalCode = false
      , existingMap = convertSM.fromSource(unminCode)
      , finish;

    existingMap = existingMap ? existingMap.toObject() : false;

    if(existingMap && existingMap.sourcesContent && existingMap.sourcesContent.length) {
      originalCode = convertSM.removeComments(existingMap.sourcesContent[0]);
      existingMap = JSON.stringify(existingMap);
    }
    // Only accept existing maps with sourcesContent
    else {
      existingMap = false;
    }

    finish = function (tempExistingMapFile) {
      if(self.opts.minify) {
        // Don't minify JSON!
        if(file.match(/\.json$/)) {
          thisStream.queue(unminCode)
        }
        else {
          var opts = {
              fromString: true
            , outSourceMap: (self.opts.map ? self.opts.map : undefined)
            , inSourceMap: (self.opts.map ? tempExistingMapFile : undefined)
          };

          if (typeof self.opts.uglify === 'object') {
            _.defaults(opts, self.opts.uglify);
          }

          var min = uglify.minify(unminCode, opts);

          thisStream.queue(convertSM.removeMapFileComments(min.code).trim());

          if(self.opts.map) {
            self.registerMap(file, originalCode || unminCode, new SMConsumer(min.map));
          }
        }
      }

      // Otherwise we'll never finish
      thisStream.queue(null);
    }

    if(existingMap) {
      tmp.file(function (err, path) {
        if(err) { throw err; }

        fs.writeFile(path, existingMap, function (err) {
          if(err) { throw err; }
          finish(path);
        });
      });
    }
    else {
      finish();
    }
  }

  throughStream = through(write, end);

  throughStream.call = function () {
    throw new Error('Transformer is a transform. Correct usage: `bundle.transform(minifier.transformer)`.')
  }

  return throughStream;
};

/*
* Consumes the output stream from Browserify
*/
Minifier.prototype.consumer = function (cb) {
  var self = this;

  return concat(function(data) {
    if(!self.opts.minify || !self.opts.map) {
      // Remove browserify's inline sourcemap
      return cb(null, convertSM.removeComments(data.toString()), null);
    }
    else {
      var bundle = self.decoupleBundle(data);

      if(bundle === false) {
        return cb(null, convertSM.removeComments(data.toString()));
      }

      // Re-maps the browserify sourcemap
      // to the original source using the
      // uglify sourcemap
      bundle.map = self.transformMap(bundle.map);

      bundle.code = bundle.code + '\n//# sourceMappingURL=' + self.opts.map

      cb(null, bundle.code, bundle.map);
    }
  });
};

/*
* Given a SourceMapConsumer from a bundle's map,
* transform it so that it maps to the unminified
* source
*/
Minifier.prototype.transformMap = function (bundleMap) {
  var self = this
    , generator = new SMGenerator({
        file: self.opts.source
      })
      // Map File -> The lowest numbered line in the bundle (offset)
    , bundleToMinMap = {}

      /*
      * Helper function that maps minified source to a line in the browserify bundle
      */
    , mapSourceToLine = function (source, line) {
        var target = bundleToMinMap[source];

        if(!target || target > line) {
          bundleToMinMap[source] = line;
        }
      }

    , hasNoMappings = function (file) {
        return bundleToMinMap[file] == null;
      }

      /*
      * Helper function that gets the line
      */
    , lineForSource = function (source) {
        if(hasNoMappings(source)) {
          throw new Error('ENOFILE: ' + source);
        }

        var target = bundleToMinMap[source];

        return target;
      }
    , missingSources = {};

  // Figure out where my minified files went in the bundle
  bundleMap.eachMapping(function (mapping) {
    if(self.fileExists(mapping.source)) {
      mapSourceToLine(mapping.source, mapping.generatedLine);
    }
    // Not a known source, pass thru the mapping
    else {
      generator.addMapping({
        generated: {
          line: mapping.generatedLine
        , column: mapping.generatedColumn
        }
      , original: {
          line: mapping.originalLine
        , column: mapping.originalColumn
        }
      , source: self.opts.compressPath(mapping.source)
      , name: mapping.name
      });

      missingSources[mapping.source] = true;
    }
  });

  if(process.env.debug) {
    console.log(' [DEBUG] Here is where Browserify put your modules:');
    _.each(bundleToMinMap, function (line, file) {
      console.log(' [DEBUG] line ' + line + ' "' + self.opts.compressPath(file) + '"');
    });
  }

  // Add sourceContent for missing sources
  _.each(missingSources, function (v, source) {
    generator.setSourceContent(self.opts.compressPath(source), bundleMap.sourceContentFor(source));
  });

  // Map from the hi-res sourcemaps to the browserify bundle
  if(process.env.debug) {
    console.log(' [DEBUG] Here is how I\'m mapping your code:');
  }

  self.eachSource(function (file, code) {
    // Ignore files with no mappings
    if(!self.fileExists(file) || hasNoMappings(file)) {
      if(process.env.debug) {
        throw new Error('File with no mappings: ' + file)
      }
      return;
    }

    var offset = lineForSource(file) - 1
      , fileMap = self.mapForFile(file)
      , transformedFileName = self.opts.compressPath(file);

    if(process.env.debug) {
      console.log(' [DEBUG]  Now mapping "' + transformedFileName + '"');
    }

    fileMap.eachMapping(function (mapping) {
      var transformedMapping = self.transformMapping(transformedFileName, mapping, offset);

      if(process.env.debug) {
        console.log(' [DEBUG]  Generated [' + transformedMapping.generated.line +
           ':' + transformedMapping.generated.column + '] > [' +
           mapping.originalLine + ':' + mapping.originalColumn + '] Original');
      }

      generator.addMapping( transformedMapping );
    });

    generator.setSourceContent(transformedFileName, code);
  });

  return generator.toString();
};

/*
* Given a mapping (from SMConsumer.eachMapping)
* return a new mapping (for SMGenerator.addMapping)
* resolved to the original source
*/
Minifier.prototype.transformMapping = function (file, mapping, offset) {
  return {
    generated: {
      line: mapping.generatedLine + offset
    , column: mapping.generatedColumn
    }
  , original: {
      line: mapping.originalLine
    , column: mapping.originalColumn
    }
  , source: file
  , name: mapping.name
  }
};

/*
* Iterates over each code file, executes a function
*/
Minifier.prototype.eachSource = function (cb) {
  var self = this;

  _.each(this.registry, function(v, file) {
    cb(file, self.codeForFile(file), self.mapForFile(file));
  });
};

/*
* Given source with embedded sourcemap, seperate the two
* Returns the code and SourcemapConsumer object seperately
*/
Minifier.prototype.decoupleBundle = function (src) {
  if(typeof src != 'string')
    src = src.toString();

  var map = convertSM.fromSource(src);
  // The source didn't have a sourcemap in it
  if(!map) {
    return false;
  }

  return {
    code: convertSM.removeComments(src)
  , map: new SMConsumer( map.toObject() )
  };
};

module.exports = Minifier;
