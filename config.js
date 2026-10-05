import "dotenv/config";

if (!process.env.SOURCE_URL) {
    throw new Error("SOURCE_URL is required in .env");
}

export default {
    sourceUrl: process.env.SOURCE_URL.replace(/\/+$/, ""),

    wpUrl: process.env.WP_URL
        ? process.env.WP_URL.replace(/\/+$/, "")
        : null,
    wpUsername: process.env.WP_USERNAME || null,
    wpAppPassword: process.env.WP_APP_PASSWORD || null,
    menuName: process.env.MENU_NAME || "Main Menu",

    migrationDir: "./migration",
    pagesDir: "./migration/pages",
    assetsDir: "./migration/assets",

    requestDelay: Number(process.env.REQUEST_DELAY || 200),
    concurrency: Number(process.env.CONCURRENCY || 5),
    resourceConcurrency: Number(
        process.env.RESOURCE_CONCURRENCY || 8
    ),

    postPathPrefixes: [
    ],

    // Importer options
    wordpressImportStatus: "draft", // Change to "publish" when ready
    forceAllPagesAsPages: false,
    forceAllPagesAsPosts: false
};
