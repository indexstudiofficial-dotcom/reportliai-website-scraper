// ============================================================
// Reportli AI - Website Content Scraper
// VERSION: 2026-09-25-V1
//
// NO AI
// NO SARVAM
// NO CHUNKING
//
// Logic:
// Website
//   ↓
// Discover all pages
//   ↓
// Fetch HTML
//   ↓
// Find H1-H6 headings
//   ↓
// Collect text under each heading
//   ↓
// Save to Supabase business_data
// ============================================================


const VERSION = "2026-09-25-V1";


// ============================================================
// SETTINGS
// ============================================================

// Number of website pages processed per Worker request.
const PAGES_PER_BATCH = 5;

// Maximum sitemap files we will recursively inspect.
const MAX_SITEMAPS = 50;

// Maximum URLs collected from sitemaps.
// Increase this if you expect very large websites.
const MAX_PAGES = 5000;

// Website fetch timeout.
const FETCH_TIMEOUT = 15000;


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env) {

    // ----------------------------------------------------------
    // ONLY POST
    // ----------------------------------------------------------

    if (request.method !== "POST") {

      return json({

        success: false,

        worker_version: VERSION,

        error: "POST required"

      }, 405);
    }


    try {

      // --------------------------------------------------------
      // READ REQUEST
      // --------------------------------------------------------

      const body =
        await request.json();


      const applicationId =
        String(
          body.application_id || ""
        ).trim();


      const domain =
        String(
          body.domain || ""
        ).trim();


      const pageOffset =
        Math.max(
          0,
          Number(
            body.page_offset || 0
          )
        );


      // --------------------------------------------------------
      // VALIDATION
      // --------------------------------------------------------

      if (!applicationId) {

        return json({

          success: false,

          worker_version: VERSION,

          error:
            "application_id required"

        }, 400);
      }


      if (!domain) {

        return json({

          success: false,

          worker_version: VERSION,

          error:
            "domain required"

        }, 400);
      }


      // --------------------------------------------------------
      // NORMALIZE WEBSITE
      // --------------------------------------------------------

      const website =
        normalizeUrl(domain);


      if (!website) {

        return json({

          success: false,

          worker_version: VERSION,

          error:
            "Invalid website URL"

        }, 400);
      }


      // ========================================================
      // STEP 1
      // DISCOVER ALL WEBSITE PAGES
      // ========================================================

      const discovery =
        await discoverAllPages(
          website
        );


      const pageUrls =
        discovery.pages;


      // ========================================================
      // STEP 2
      // SELECT CURRENT BATCH
      // ========================================================

      const selectedPages =
        pageUrls.slice(

          pageOffset,

          pageOffset +
            PAGES_PER_BATCH

        );


      // ========================================================
      // STATISTICS
      // ========================================================

      const stats = {

        pages_discovered:
          pageUrls.length,

        pages_selected:
          selectedPages.length,

        pages_processed:
          0,

        pages_failed:
          0,

        headings_found:
          0,

        rows_saved:
          0,

        rows_failed:
          0
      };


      const pageResults = [];


      // ========================================================
      // STEP 3
      // PROCESS EACH PAGE
      // ========================================================

      for (
        const pageUrl
        of selectedPages
      ) {

        try {

          // ----------------------------------------------------
          // FETCH HTML
          // ----------------------------------------------------

          const html =
            await fetchHtml(
              pageUrl
            );


          // ----------------------------------------------------
          // EXTRACT HEADING SECTIONS
          // ----------------------------------------------------

          const sections =
            extractHeadingSections(
              html
            );


          stats.headings_found +=
            sections.length;


          // ----------------------------------------------------
          // CREATE SUPABASE ROWS
          // ----------------------------------------------------

          const rows = [];


          for (
            const section
            of sections
          ) {

            // Do not save empty sections.
            if (
              !section.heading ||
              !section.text
            ) {
              continue;
            }


            rows.push({

              application_id:
                applicationId,

              field:
                section.heading,

              data:
                section.text,

              source_url:
                pageUrl
            });
          }


          // ----------------------------------------------------
          // SAVE ALL SECTIONS FROM THIS PAGE
          // WITH ONE SUPABASE REQUEST
          // ----------------------------------------------------

          if (
            rows.length > 0
          ) {

            const saved =
              await saveRows(
                env,
                rows
              );


            if (!saved.success) {

              stats.rows_failed +=
                rows.length;

              throw new Error(
                saved.error
              );
            }


            stats.rows_saved +=
              rows.length;
          }


          // ----------------------------------------------------
          // PAGE SUCCESS
          // ----------------------------------------------------

          stats.pages_processed++;


          pageResults.push({

            url:
              pageUrl,

            success:
              true,

            headings_found:
              sections.length,

            rows_saved:
              rows.length
          });


        } catch (error) {

          // ----------------------------------------------------
          // PAGE FAILED
          // ----------------------------------------------------

          stats.pages_failed++;


          pageResults.push({

            url:
              pageUrl,

            success:
              false,

            error:
              error?.message ||
              String(error)
          });
        }
      }


      // ========================================================
      // STEP 4
      // PAGINATION
      // ========================================================

      const nextOffset =
        pageOffset +
        selectedPages.length;


      const hasMore =
        nextOffset <
        pageUrls.length;


      // ========================================================
      // FINAL RESPONSE
      // ========================================================

      return json({

        success: true,

        worker_version:
          VERSION,

        application_id:
          applicationId,

        website,

        discovery: {

          pages_found:
            pageUrls.length,

          sitemaps_checked:
            discovery.sitemaps_checked,

          sitemap_errors:
            discovery.sitemap_errors
        },

        stats,

        pagination: {

          page_offset:
            pageOffset,

          next_offset:
            nextOffset,

          has_more_pages:
            hasMore,

          total_pages:
            pageUrls.length
        },

        page_results:
          pageResults,

        message:
          hasMore

            ? `Continue with page_offset=${nextOffset}`

            : "All pages processed."
      });


    } catch (error) {

      // ========================================================
      // GLOBAL ERROR
      // ========================================================

      return json({

        success: false,

        worker_version:
          VERSION,

        error:
          error?.message ||
          String(error)

      }, 500);
    }
  }
};


// ============================================================
// URL NORMALIZATION
// ============================================================

function normalizeUrl(value) {

  try {

    const url =
      new URL(
        String(value || "").trim()
      );


    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {

      return null;
    }


    // Remove #section.
    url.hash = "";


    return url.href;

  } catch {

    return null;
  }
}


// ============================================================
// DISCOVER ALL WEBSITE PAGES
// ============================================================

async function discoverAllPages(
  website
) {

  const origin =
    new URL(website).origin;


  const pages =
    new Set();


  const sitemapQueue =
    [];


  const checkedSitemaps =
    new Set();


  let sitemapErrors = 0;


  // ----------------------------------------------------------
  // Always include homepage
  // ----------------------------------------------------------

  pages.add(
    normalizeUrl(website)
  );


  // ----------------------------------------------------------
  // Common sitemap locations
  // ----------------------------------------------------------

  const commonSitemaps = [

    `${origin}/sitemap.xml`,

    `${origin}/wp-sitemap.xml`,

    `${origin}/sitemap_index.xml`,

    `${origin}/sitemap-index.xml`

  ];


  for (
    const sitemap
    of commonSitemaps
  ) {

    sitemapQueue.push(
      sitemap
    );
  }


  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  try {

    const robotsResponse =
      await fetchWithTimeout(
        `${origin}/robots.txt`
      );


    if (
      robotsResponse.ok
    ) {

      const robots =
        await robotsResponse.text();


      const robotSitemaps =
        extractSitemapUrls(
          robots
        );


      for (
        const sitemap
        of robotSitemaps
      ) {

        sitemapQueue.push(
          sitemap
        );
      }
    }

  } catch {

    // robots.txt is optional.
  }


  // ----------------------------------------------------------
  // PROCESS SITEMAPS
  // ----------------------------------------------------------

  while (

    sitemapQueue.length > 0 &&

    checkedSitemaps.size <
      MAX_SITEMAPS &&

    pages.size <
      MAX_PAGES

  ) {

    const sitemap =
      sitemapQueue.shift();


    const normalizedSitemap =
      normalizeUrl(
        sitemap
      );


    if (!normalizedSitemap) {
      continue;
    }


    if (
      checkedSitemaps.has(
        normalizedSitemap
      )
    ) {
      continue;
    }


    checkedSitemaps.add(
      normalizedSitemap
    );


    try {

      const response =
        await fetchWithTimeout(
          normalizedSitemap
        );


      if (
        !response.ok
      ) {

        sitemapErrors++;

        continue;
      }


      const contentType =
        (
          response.headers.get(
            "content-type"
          ) || ""
        ).toLowerCase();


      const content =
        await response.text();


      // ------------------------------------------------------
      // Some servers incorrectly return
      // text/plain for XML.
      // Therefore we inspect the content too.
      // ------------------------------------------------------

      const locations =
        extractLocs(
          content
        );


      if (
        locations.length === 0
      ) {

        continue;
      }


      // ------------------------------------------------------
      // Determine whether this is:
      //
      // sitemap index
      // OR
      // normal URL sitemap
      // ------------------------------------------------------

      const looksLikeSitemapIndex =
        /<sitemapindex[\s>]/i.test(
          content
        );


      if (
        looksLikeSitemapIndex
      ) {

        // ----------------------------------------------------
        // THIS SITEMAP CONTAINS OTHER SITEMAPS
        // ----------------------------------------------------

        for (
          const child
          of locations
        ) {

          if (
            sitemapQueue.length +
            checkedSitemaps.size >=
            MAX_SITEMAPS
          ) {
            break;
          }


          const childUrl =
            normalizeUrl(
              child
            );


          if (!childUrl) {
            continue;
          }


          if (
            !checkedSitemaps.has(
              childUrl
            )
          ) {

            sitemapQueue.push(
              childUrl
            );
          }
        }

      } else {

        // ----------------------------------------------------
        // NORMAL URL SITEMAP
        // ----------------------------------------------------

        for (
          const pageUrl
          of locations
        ) {

          if (
            pages.size >=
            MAX_PAGES
          ) {
            break;
          }


          const normalizedPage =
            normalizeUrl(
              pageUrl
            );


          if (!normalizedPage) {
            continue;
          }


          if (
            !isHtmlPage(
              normalizedPage
            )
          ) {
            continue;
          }


          // Only pages belonging to this website.
          if (
            !sameOrigin(
              website,
              normalizedPage
            )
          ) {
            continue;
          }


          pages.add(
            normalizedPage
          );
        }
      }


    } catch {

      sitemapErrors++;
    }
  }


  return {

    pages:
      Array.from(pages),

    sitemaps_checked:
      checkedSitemaps.size,

    sitemap_errors:
      sitemapErrors
  };
}


// ============================================================
// EXTRACT SITEMAP URLS FROM robots.txt
// ============================================================

function extractSitemapUrls(
  robots
) {

  const output = [];


  const lines =
    String(
      robots || ""
    ).split(/\r?\n/);


  for (
    const line
    of lines
  ) {

    const match =
      line.match(
        /^\s*sitemap\s*:\s*(.+?)\s*$/i
      );


    if (!match) {
      continue;
    }


    const url =
      normalizeUrl(
        match[1]
      );


    if (url) {

      output.push(
        url
      );
    }
  }


  return output;
}


// ============================================================
// EXTRACT <loc> FROM XML
// ============================================================

function extractLocs(
  xml
) {

  const output = [];


  const regex =
    /<loc[^>]*>([\s\S]*?)<\/loc>/gi;


  let match;


  while (
    (match =
      regex.exec(xml))
  ) {

    const value =
      decodeHtmlEntities(
        match[1]
      ).trim();


    if (value) {

      output.push(
        value
      );
    }
  }


  return output;
}


// ============================================================
// CHECK SAME WEBSITE
// ============================================================

function sameOrigin(
  website,
  page
) {

  try {

    const websiteUrl =
      new URL(
        website
      );


    const pageUrl =
      new URL(
        page
      );


    return (
      websiteUrl.origin ===
      pageUrl.origin
    );

  } catch {

    return false;
  }
}


// ============================================================
// CHECK WHETHER URL IS AN HTML PAGE
// ============================================================

function isHtmlPage(
  value
) {

  try {

    const url =
      new URL(
        value
      );


    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {

      return false;
    }


    const path =
      url.pathname.toLowerCase();


    // --------------------------------------------------------
    // Files that are definitely NOT HTML pages.
    // --------------------------------------------------------

    const blockedExtensions = [

      // Data
      ".xml",
      ".json",
      ".csv",
      ".txt",

      // Images
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".svg",
      ".ico",
      ".bmp",
      ".tiff",

      // Documents
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",

      // Archives
      ".zip",
      ".rar",
      ".7z",
      ".tar",
      ".gz",

      // Video
      ".mp4",
      ".webm",
      ".mov",
      ".avi",
      ".mkv",

      // Audio
      ".mp3",
      ".wav",
      ".ogg",
      ".m4a",

      // Code/assets
      ".js",
      ".css",
      ".map",

      // Fonts
      ".woff",
      ".woff2",
      ".ttf",
      ".otf",
      ".eot"
    ];


    for (
      const extension
      of blockedExtensions
    ) {

      if (
        path.endsWith(
          extension
        )
      ) {

        return false;
      }
    }


    return true;

  } catch {

    return false;
  }
}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
      FETCH_TIMEOUT
    );


  try {

    return await fetch(
      url,
      {

        headers: {

          "User-Agent":
            "ReportliAI-WebsiteCrawler/1.0",

          "Accept":
            "text/html,application/xhtml+xml,application/xml,text/xml,text/plain"

        },

        signal:
          controller.signal
      }
    );

  } finally {

    clearTimeout(
      timer
    );
  }
}


// ============================================================
// FETCH HTML PAGE
// ============================================================

async function fetchHtml(
  url
) {

  const response =
    await fetchWithTimeout(
      url
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `HTTP ${response.status}`
    );
  }


  const contentType =
    (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();


  // ----------------------------------------------------------
  // Reject obvious non-HTML content.
  // ----------------------------------------------------------

  if (
    contentType &&
    !contentType.includes(
      "text/html"
    ) &&
    !contentType.includes(
      "application/xhtml+xml"
    )
  ) {

    throw new Error(
      `Not HTML: ${contentType}`
    );
  }


  return await response.text();
}


// ============================================================
// EXTRACT HEADING SECTIONS
//
// Example:
//
// <h2>Services</h2>
// <p>Dental implants.</p>
// <p>Braces.</p>
//
// <h3>Dental Implants</h3>
// <p>Implants information.</p>
//
// Produces:
//
// {
//   heading: "Services",
//   text: "Dental implants. Braces."
// }
//
// {
//   heading: "Dental Implants",
//   text: "Implants information."
// }
// ============================================================

function extractHeadingSections(
  html
) {

  let source =
    String(
      html || ""
    );


  // ----------------------------------------------------------
  // Remove sections that usually contain navigation,
  // scripts, styles and unrelated page content.
  // ----------------------------------------------------------

  source =
    source.replace(

      /<(script|style|noscript|svg|canvas|iframe|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi,

      " "
    );


  // ----------------------------------------------------------
  // Find H1-H6 and text in between.
  // ----------------------------------------------------------

  const headingRegex =
    /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;


  const matches = [];


  let match;


  while (
    (match =
      headingRegex.exec(source))
  ) {

    const headingTag =
      match[1]
        .toLowerCase();


    const headingText =
      htmlToText(
        match[2]
      );


    if (!headingText) {
      continue;
    }


    matches.push({

      level:
        Number(
          headingTag.substring(1)
        ),

      heading:
        headingText,

      start:
        match.index,

      end:
        headingRegex.lastIndex
    });
  }


  const sections = [];


  // ----------------------------------------------------------
  // For every heading, collect content until the next heading.
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < matches.length;
    i++
  ) {

    const current =
      matches[i];


    const next =
      matches[i + 1];


    const contentStart =
      current.end;


    const contentEnd =
      next
        ? next.start
        : source.length;


    const rawContent =
      source.slice(
        contentStart,
        contentEnd
      );


    const text =
      htmlToText(
        rawContent
      );


    if (!text) {
      continue;
    }


    sections.push({

      heading:
        current.heading,

      text

    });
  }


  return sections;
}


// ============================================================
// CONVERT HTML TO CLEAN TEXT
// ============================================================

function htmlToText(
  html
) {

  let value =
    String(
      html || ""
    );


  // ----------------------------------------------------------
  // Remove comments
  // ----------------------------------------------------------

  value =
    value.replace(
      /<!--[\s\S]*?-->/g,
      " "
    );


  // ----------------------------------------------------------
  // Convert common block tags to spaces.
  // ----------------------------------------------------------

  value =
    value.replace(
      /<(br|p|div|section|article|li|ul|ol|table|tr|td|th|blockquote|pre|address|figure|figcaption)[^>]*>/gi,
      " "
    );


  // ----------------------------------------------------------
  // Remove remaining HTML tags.
  // ----------------------------------------------------------

  value =
    value.replace(
      /<[^>]+>/g,
      " "
    );


  // ----------------------------------------------------------
  // Decode entities.
  // ----------------------------------------------------------

  value =
    decodeHtmlEntities(
      value
    );


  // ----------------------------------------------------------
  // Normalize whitespace.
  // ----------------------------------------------------------

  value =
    value
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  return value;
}


// ============================================================
// HTML ENTITY DECODER
// ============================================================

function decodeHtmlEntities(
  value
) {

  return String(
    value || ""
  )

    .replace(
      /&nbsp;/gi,
      " "
    )

    .replace(
      /&amp;/gi,
      "&"
    )

    .replace(
      /&quot;/gi,
      '"'
    )

    .replace(
      /&#39;/gi,
      "'"
    )

    .replace(
      /&apos;/gi,
      "'"
    )

    .replace(
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
    )

    // Decimal entities
    .replace(
      /&#(\d+);/g,
      (_, code) => {

        try {

          return String.fromCodePoint(
            Number(code)
          );

        } catch {

          return "";
        }
      }
    )

    // Hex entities
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) => {

        try {

          return String.fromCodePoint(
            parseInt(
              code,
              16
            )
          );

        } catch {

          return "";
        }
      }
    );
}


// ============================================================
// SUPABASE BULK SAVE
// ============================================================

async function saveRows(
  env,
  rows
) {

  try {

    if (
      !env.SUPABASE_URL
    ) {

      return {

        success: false,

        error:
          "SUPABASE_URL secret is missing"
      };
    }


    if (
      !env.SUPABASE_SECRET_KEY
    ) {

      return {

        success: false,

        error:
          "SUPABASE_SECRET_KEY secret is missing"
      };
    }


    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Your business_data table should have:
    //
    // UNIQUE(application_id, source_url, field)
    //
    // --------------------------------------------------------

    const endpoint =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?on_conflict=application_id,source_url,field`;


    const response =
      await fetch(
        endpoint,
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "apikey":
              env.SUPABASE_SECRET_KEY,

            "Authorization":
              `Bearer ${env.SUPABASE_SECRET_KEY}`,

            "Prefer":
              "resolution=merge-duplicates,return=minimal"
          },

          body:
            JSON.stringify(
              rows
            )
        }
      );


    if (
      !response.ok
    ) {

      const error =
        await response.text();


      return {

        success: false,

        error:
          `Supabase ${response.status}: ${error}`
      };
    }


    return {

      success: true

    };


  } catch (error) {

    return {

      success: false,

      error:
        error?.message ||
        String(error)
    };
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data,
      null,
      2
    ),

    {

      status,

      headers: {

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"

      }
    }
  );
  }
