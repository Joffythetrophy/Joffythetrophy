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

      config.module.rules.push({
        test: /\.m?js/,
        resolve: { fullySpecified: false },
      });

      return config;
    },
  },
};