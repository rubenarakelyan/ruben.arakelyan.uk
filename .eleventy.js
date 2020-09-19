const fs = require("fs");

module.exports = function (eleventyConfig) {
  // Copy static files
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/img");
  eleventyConfig.addPassthroughCopy("src/robots.txt");

  // 404 page config
  eleventyConfig.setBrowserSyncConfig({
    callbacks: {
      ready: function(err, bs) {

        bs.addMiddleware("*", (req, res) => {
          const content_404 = fs.readFileSync("dist/404.html");
          // Provides the 404 content without redirect.
          res.write(content_404);
          // Add 404 http status code in request header.
          res.writeHead(404);
          res.end();
        });
      }
    }
  });

  return {
    dir: {
      input: "src",
      output: "dist",
      includes: "./_includes",
      layouts: "./_layouts",
      data: "./_data"
    }
  };
};
