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

      config.ignoreWarnings = [...(config.ignoreWarnings || []), /Failed to parse source map/];

      // Remove or relax source-map-loader on problematic node_modules
      try {
        const smLoaderMatcher = (r) => (r && r.use && (
          (Array.isArray(r.use) && r.use.find(u => (typeof u === 'string' && u.includes('source-map-loader')) || (u && u.loader && u.loader.includes('source-map-loader'))))
        )) || (r && r.loader && r.loader.includes && r.loader.includes('source-map-loader'));

        const applyExclude = (rule) => {
          if (!rule) return;
          if (smLoaderMatcher(rule)) {
            rule.exclude = [
              /node_modules\/superstruct\//,
              /node_modules\/@walletconnect\//,
              /node_modules\/cross-fetch\//,
            ];
          }
          if (rule.oneOf && Array.isArray(rule.oneOf)) rule.oneOf.forEach(applyExclude);
          if (rule.rules && Array.isArray(rule.rules)) rule.rules.forEach(applyExclude);
        };
        (config.module.rules || []).forEach(applyExclude);
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