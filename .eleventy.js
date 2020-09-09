module.exports = function (eleventyConfig) {
  // Copy static files
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/img");
  eleventyConfig.addPassthroughCopy("src/robots.txt");

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
