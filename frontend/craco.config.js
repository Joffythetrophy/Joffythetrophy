const webpack = require("webpack");

module.exports = {
  webpack: {
    configure: (config) => {
      config.resolve = config.resolve || {};
      config.resolve.fallback = Object.assign({}, config.resolve.fallback, {
        crypto: false,
        stream: false,
        assert: false,
        http: false,
        https: false,
        os: false,
        url: false,
        zlib: false,
        buffer: require.resolve("buffer"),
        process: require.resolve("process/browser"),
      });

      config.plugins = config.plugins || [];
      config.plugins.push(
        new webpack.ProvidePlugin({
          process: "process/browser",
          Buffer: ["buffer", "Buffer"],
        })
      );

      // Alias superstruct to root installation to avoid nested path issues
      config.resolve.alias = Object.assign({}, config.resolve.alias || {}, {
        superstruct: require.resolve("superstruct"),
        "@solana/web3.js/node_modules/superstruct": require.resolve("superstruct"),
      });

      config.ignoreWarnings = [...(config.ignoreWarnings || []), /Failed to parse source map/];

      // Remove or relax source-map-loader on problematic node_modules
      try {
        const hasSML = (r) => (r && r.use && (
          (Array.isArray(r.use) && r.use.find(u => (typeof u === 'string' && u.includes('source-map-loader')) || (u && u.loader && u.loader.includes('source-map-loader'))))
        )) || (r && r.loader && r.loader.includes && r.loader.includes('source-map-loader'));

        const stripSML = (rules) => {
          if (!Array.isArray(rules)) return rules;
          return rules
            .filter(r => !hasSML(r))
            .map(r => {
              if (r.oneOf) r.oneOf = stripSML(r.oneOf);
              if (r.rules) r.rules = stripSML(r.rules);
              return r;
            });
        };
        config.module.rules = stripSML(config.module.rules || []);
      } catch (e) {
        // ignore
      }

      config.module.rules.push({
        test: /\.m?js/,
        resolve: { fullySpecified: false },
      });

      return config;
    },
  },
};