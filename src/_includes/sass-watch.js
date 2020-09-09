const fs = require("fs");
const path = require("path");
const sass = require("node-sass");

const generateCSS = (_scssPath, _cssPath) => {
  // Encapsulate rendered CSS from _scssPath into renderedCSS variable
  const renderedCSS = sass.renderSync({ file: _scssPath });

  // Then write result CSS string to _cssPath file
  fs.writeFile(_cssPath, renderedCSS.css.toString(), (writeErr) => {
    if (writeErr) throw writeErr;

    console.log(`CSS file saved: ${_cssPath}`);
  });
};

module.exports = (scssPath, cssPath) => {
  // If cssPath directory doesn't already exist, add it
  if (!fs.existsSync(path.dirname(cssPath))) {
    console.log(`Creating new CSS directory: ${path.dirname(cssPath)}/`);

    // Create cssPath directory recursively
    fs.mkdir(path.dirname(cssPath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) throw mkdirErr;

      console.log("CSS directory created.");

      generateCSS(scssPath, cssPath);
    });
  }

  // Generate CSS on startup
  generateCSS(scssPath, cssPath);

  // Use Node's fs.watch to catch subsequent changes to scssPath directory
  fs.watch(path.dirname(scssPath), (evType, filename) => {
    console.log(`SCSS file changed: ${path.dirname(scssPath)}/${filename}`);

    generateCSS(scssPath, cssPath);
  });
};
