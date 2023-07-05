const path = require("path");
const gulp = require("gulp");
const mjml = require("gulp-mjml");
const mjmlEngine = require("mjml");
const browserSync = require("browser-sync");
const i18n = require("gulp-html-i18n");
const log = require("fancy-log");
const rename = require("gulp-rename");
const reload = browserSync.reload;
const fs = require("fs");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer");
const tap = require("gulp-tap");
const rewriteImagePath = require("gulp-rewrite-image-path");

// AWS PUBLISH
const awspublish = require("gulp-awspublish");
const cloudfront = require("gulp-cloudfront-invalidate-aws-publish");
const parallelize = require("concurrent-transform");

// gulp-html-beautify
const htmlbeautify = require("gulp-html-beautify");

require("dotenv").config();

const argv = require("minimist")(process.argv.slice(2));

const PHRASE_API_TOKEN = process.env["PHRASE_API_TOKEN"];
const PHRASE_API_PROJECT_ID = process.env["PHRASE_API_PROJECT_ID"];
const LOCALE_FILENAME = process.env["LOCALE_FILENAME"];
/**
 * mjml -> html -> remove dev comments -> minify |
 * get translations from localise                | -> apply i18n -> emails -> folders grouping (optional)
 */

const basePaths = {
  src: "./emails/",
  subjectsSrc: "./emails/templates/",
  mjmlOutputDest: "./output/mjml/",
  translatedStringsDest: "./output/translations/",
  emailsOutputDest: "./output/emails/",
  prodReadyEmailsDest: "./output/prod/emails/",
  screenshotDest: "./output/screenshots/",
};
const paths = {
  mjml: {
    src: basePaths.src + "templates/**/*.mjml",
    dest: basePaths.mjmlOutputDest,
    includes: basePaths.src + "includes/**/*.mjml",
  },
  i18n: {
    emailsSrc: basePaths.mjmlOutputDest + "**/*.html", // result of mjml
    emailSubjectsSrc: basePaths.subjectsSrc + "**/*.html", // email template subjects
    languagesSrc: basePaths.translatedStringsDest, // downloaded from localize
    dest: basePaths.emailsOutputDest, // final emails
    screenshotsSrc: basePaths.screenshotDest,
  },
  prodDest: basePaths.prodReadyEmailsDest,
};

/** Dev server */
function server(done) {
  let watchDir = paths.i18n.dest;
  // $gulp --mjml
  // will start watch for lokalised emails
  if (argv.mjml) {
    watchDir = paths.mjml.dest;
  }
  const options = {
    server: {
      baseDir: watchDir,
      directory: true,
    },
    port: "8000",
    notify: false,
  };
  browserSync.init(options);
  done();
}

function buildMjmlToHtml() {
  const beautifyOptions = {
    indentSize: 4,
    end_with_newline: true,
    max_preserve_newlines: 0,
  };
  return gulp.src(paths.mjml.src).pipe(mjml()).pipe(htmlbeautify(beautifyOptions)).pipe(gulp.dest(paths.mjml.dest));
}

// prod only task
function buildMjmlToHtmlAndMinify() {
  return (
    gulp
      .src(paths.mjml.src)
      // keepComments config mentioned here https://github.com/mjmlio/mjml/issues/1364
      .pipe(mjml(mjmlEngine, { minify: true, keepComments: false }))
      .pipe(gulp.dest(paths.mjml.dest))
  );
}

function generateLocalizedEmails() {
  // {{ trans('mails.Hi-calendars-1') }}
  const regex = /{{ ?trans\('([\w\-.]+)'\) ?}}/g;
  return gulp
    .src([paths.i18n.emailsSrc])
    .pipe(
      i18n({
        langDir: paths.i18n.languagesSrc,
        langRegExp: regex,
      })
    )
    .pipe(gulp.dest(paths.i18n.dest));
}

function watch() {
  gulp
    .watch([paths.mjml.src, paths.i18n.emailSubjectsSrc])
    .on("change", gulp.series(buildMjmlToHtml, generateLocalizedEmails, rewrite, reload));

  gulp.watch(paths.mjml.includes).on("change", gulp.series(buildMjmlToHtml, generateLocalizedEmails, rewrite, reload));
}

/** 下載 phrase 多語系檔 */
async function downloadTranslationsFromPhrase() {
  ["zh-TW", "zh-CN", "en"].forEach(async (locale) => {
    url = new URL(`https://api.phrase.com/v2/projects/${PHRASE_API_PROJECT_ID}/locales/${locale}/download`);

    const params = {
      file_format: "nested_json",
      include_empty_translations: true,
      exclude_empty_zero_forms: false,
      include_translated_keys: true,
      keep_notranslate_tags: false,
      encoding: "UTF-8",
      include_unverified_translations: true,
      fallback_locale_id: "zh-TW",
    };
    const headers = new fetch.Headers();
    url.search = new URLSearchParams(params).toString();
    headers.append("Accept", "*");
    headers.append("Authorization", `token ${PHRASE_API_TOKEN}`);
    const data = await fetch(url, { headers });
    // const json = await data.json();
    const text = await data.text();

    filepath = `${basePaths.translatedStringsDest}${locale}/${LOCALE_FILENAME}`;
    if (!fs.existsSync(path.dirname(filepath))) {
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
    }

    if (fs.exis) console.log(path.dirname(filepath));
    fs.writeFile(filepath, text, (err) => {
      if (err) console.log(err);
    });
  });
}

/** 產生縮圖 */
function generateScreenShots() {
  const files = [];
  return gulp
    .src(paths.i18n.dest + "**/*.html")
    .pipe(
      tap((file) => {
        files.push(file);
      })
    )
    .on("end", async () => {
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();

      for (let i = 0, len = files.length; i < len; i++) {
        const file = files[i];
        const filename = path.basename(file.basename, ".html") + ".png";
        const exportPath = `${path.dirname(file.path)}/${filename}`;
        await page.goto("file://" + file.path, { waitUntil: "networkidle0" });
        await page.screenshot({ path: exportPath, fullPage: true });
      }

      await browser.close();
    });
}

/** 將 output/emails 圖片連結替換成 cloudfront_url */
function rewrite() {
  if (process.env.AWS_CLOUDFRONT_URL) {
    let g = gulp.src(paths.i18n.dest + "*/**");

    g = g.pipe(rewriteImagePath({ path: `${process.env.AWS_CLOUDFRONT_URL}` }));

    g = g.pipe(gulp.dest(paths.i18n.dest));

    return g;
  }
}

/** 將素材上傳到 aws s3 */
function upload() {
  // TODO. 將靜態檔案自動上傳到 AWS S3 上面並且替換成 cloudfront 的路徑
  const config = {
    // Required
    params: {
      Bucket: process.env.AWS_BUCKET_NAME,
    },
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      signatureVersion: "v3",
    },

    // Optional
    deleteOldVersions: false, // NOT FOR PRODUCTION
    distribution: process.env.AWS_CLOUDFRONT, // CloudFront distribution ID
    region: process.env.AWS_DEFAULT_REGION,
    headers: {
      "Cache-Control": "max-age=315360000, no-transform, public",
    },

    // Sensible Defaults - gitignore these Files and Dirs
    distDir: "emails/images",
    indexRootPath: true,
    cacheFileName: ".awspublish",
    concurrentUploads: 10,
    wait: true, // wait for CloudFront invalidation to complete (about 30-60 seconds)
  };
  // create a new publisher using S3 options
  // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#constructor-property
  const publisher = awspublish.create(config);

  let g = gulp.src("./" + config.distDir + "/**");

  g = g.pipe(
    rename(function (path) {
      path.dirname = path.dirname === "." ? "mails" : "mails/" + path.dirname;
    })
  );

  // publisher will add Content-Length, Content-Type and headers specified above
  // If not specified it will set x-amz-acl to public-read by default
  g = g.pipe(parallelize(publisher.publish(config.headers, { noAcl: true }), config.concurrentUploads));

  // Invalidate CDN
  if (config.distribution) {
    console.log("Configured with CloudFront distribution");
    g = g.pipe(cloudfront(config));
  } else {
    console.log("No CloudFront distribution configured - skipping CDN invalidation");
  }

  // Delete removed files
  if (config.deleteOldVersions) {
    g = g.pipe(publisher.sync());
  }
  // create a cache file to speed up consecutive uploads
  // g = g.pipe(publisher.cache());
  // print upload updates to console
  g = g.pipe(awspublish.reporter());

  return g;
}

/**
 * Task will group localized templates of content and subject in one folder per email type.
 */
function groupEmailTemplatesByFolders() {
  return gulp.src(paths.i18n.dest + "**/*.html").pipe(gulp.dest(paths.prodDest));
}

// 執行步驟
gulp.task("download-translations", downloadTranslationsFromPhrase);
gulp.task("build-mjml-to-html", buildMjmlToHtml);
gulp.task("generate-localized-emails", generateLocalizedEmails);
gulp.task("upload", upload);
gulp.task("rewrite", rewrite);
gulp.task("screenshots", generateScreenShots);

/**
 * Task will build mjml templates.
 * On mjml changes will rebuild mjml and apply translations if any.
 */
gulp.task("default", gulp.series(buildMjmlToHtml, generateLocalizedEmails, rewrite, gulp.parallel(server, watch)));

/**
 * Task will:
 * 1) build .mjml to .html (minify, remove comments)
 * 2) download translations from Lokalise
 * 3) lokalise all .html files
 * 4) group emails by folders (localized subject and content templates will be in one folder)
 */
gulp.task(
  "prod",
  gulp.series(
    gulp.parallel(buildMjmlToHtmlAndMinify, downloadTranslationsFromPhrase),
    generateLocalizedEmails,
    groupEmailTemplatesByFolders
  )
);
