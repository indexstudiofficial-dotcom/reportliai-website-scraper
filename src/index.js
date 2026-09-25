// ============================================================
// MRME - WEBSITE KNOWLEDGE SCRAPER
// VERSION: 2026-09-25-V1
//
// NO AI
// NO SARVAM
// DETERMINISTIC WEBSITE SCRAPER
//
// Main flow:
//
// Website
//   ↓
// Sitemap + robots.txt + internal links
//   ↓
// Discover URLs
//   ↓
// Filter + deduplicate
//   ↓
// Fetch HTML
//   ↓
// Remove useless HTML
//   ↓
// Extract:
//   - H1-H6 sections
//   - paragraphs
//   - lists
//   - JSON-LD
//   - useful links
//   ↓
// Clean + deduplicate
//   ↓
// Save to Supabase
// ============================================================


const VERSION = "2026-09-25-V1";


// ============================================================
// SETTINGS
// ============================================================

// Number of pages processed by ONE Worker invocation.
const PAGES_PER_BATCH = 5;

// Maximum pages that can be discovered.
const MAX_PAGES = 5000;

// Maximum sitemap files that can be checked.
const MAX_SITEMAPS = 50;

// Maximum internal links discovered from each page.
const MAX_LINKS_PER_PAGE = 100;

// Maximum HTML size accepted for a page.
// 5 MB.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Request timeout.
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
      // READ BODY
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
        normalizeUrl(
          domain
        );


      if (!website) {

        return json({

          success: false,

          worker_version: VERSION,

          error:
            "Invalid website URL"

        }, 400);
      }


      const websiteOrigin =
        new URL(
          website
        ).origin;


      // ========================================================
      // 1. DISCOVER WEBSITE PAGES
      // ========================================================

      const discovery =
        await discoverAllPages(
          website
        );


      let pageUrls =
        discovery.pages;


      // Make absolutely sure all URLs belong
      // to the customer's website.
      pageUrls =
        pageUrls
          .filter(
            url =>
              sameOrigin(
                website,
                url
              )
          )
          .filter(
            isHtmlPage
          );


      // Final deduplication.
      pageUrls =
        Array.from(
          new Set(
            pageUrls
          )
        );


      // ========================================================
      // 2. SELECT CURRENT BATCH
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

        sections_found:
          0,

        json_ld_blocks_found:
          0,

        useful_links_found:
          0,

        rows_prepared:
          0,

        rows_saved:
          0,

        rows_failed:
          0
      };


      const pageResults = [];


      // ========================================================
      // 3. PROCESS EACH PAGE
      // ========================================================

      for (
        const pageUrl
        of selectedPages
      ) {

        try {

          // ----------------------------------------------------
          // FETCH PAGE
          // ----------------------------------------------------

          const html =
            await fetchHtml(
              pageUrl
            );


          // ----------------------------------------------------
          // EXTRACT PAGE CONTENT
          // ----------------------------------------------------

          const extracted =
            extractPageContent(
              html
            );


          stats.sections_found +=
            extracted.sections.length;


          stats.json_ld_blocks_found +=
            extracted.jsonLd.length;


          stats.useful_links_found +=
            extracted.links.length;


          // ----------------------------------------------------
          // CREATE DATABASE ROWS
          // ----------------------------------------------------

          const rows =
            buildRows(
              applicationId,
              pageUrl,
              extracted
            );


          stats.rows_prepared +=
            rows.length;


          // ----------------------------------------------------
          // SAVE PAGE DATA
          //
          // ONE SUPABASE REQUEST PER PAGE.
          // ----------------------------------------------------

          if (
            rows.length > 0
          ) {

            const saveResult =
              await saveRows(
                env,
                rows
              );


            if (
              !saveResult.success
            ) {

              stats.rows_failed +=
                rows.length;

              throw new Error(
                saveResult.error
              );
            }


            stats.rows_saved +=
              rows.length;
          }


          // ----------------------------------------------------
          // SUCCESS
          // ----------------------------------------------------

          stats.pages_processed++;


          pageResults.push({

            url:
              pageUrl,

            success:
              true,

            sections:
              extracted.sections.length,

            json_ld:
              extracted.jsonLd.length,

            links:
              extracted.links.length,

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
      // 4. PAGINATION
      // ========================================================

      const nextOffset =
        pageOffset +
        selectedPages.length;


      const hasMore =
        nextOffset <
        pageUrls.length;


      // ========================================================
      // RESPONSE
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
            discovery.sitemap_errors,

          internal_links_found:
            discovery.internal_links_found
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

function normalizeUrl(
  value
) {

  try {

    const url =
      new URL(
        String(
          value || ""
        ).trim()
      );


    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {

      return null;
    }


    // Remove fragment.
    url.hash = "";


    // Remove trailing slash except root.
    if (
      url.pathname.length > 1 &&
      url.pathname.endsWith("/")
    ) {

      url.pathname =
        url.pathname.slice(
          0,
          -1
        );
    }


    return url.href;

  } catch {

    return null;
  }
}


// ============================================================
// DISCOVER ALL PAGES
// ============================================================

async function discoverAllPages(
  website
) {

  const origin =
    new URL(
      website
    ).origin;


  const pages =
    new Set();


  const sitemapQueue =
    [];


  const checkedSitemaps =
    new Set();


  let sitemapErrors = 0;


  let internalLinksFound = 0;


  // ----------------------------------------------------------
  // Always include homepage.
  // ----------------------------------------------------------

  pages.add(
    normalizeUrl(
      website
    )
  );


  // ----------------------------------------------------------
  // Common sitemap locations.
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
  // ROBOTS.TXT
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


      const content =
        await response.text();


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
      // SITEMAP INDEX
      // ------------------------------------------------------

      if (
        /<sitemapindex[\s>]/i.test(
          content
        )
      ) {

        for (
          const child
          of locations
        ) {

          if (
            checkedSitemaps.size +
            sitemapQueue.length >=
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


        continue;
      }


      // ------------------------------------------------------
      // NORMAL URL SITEMAP
      // ------------------------------------------------------

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
          !sameOrigin(
            website,
            normalizedPage
          )
        ) {
          continue;
        }


        if (
          !isHtmlPage(
            normalizedPage
          )
        ) {
          continue;
        }


        pages.add(
          normalizedPage
        );
      }


    } catch {

      sitemapErrors++;
    }
  }


  // ==========================================================
  // IMPORTANT:
  //
  // Sitemaps are not always complete.
  //
  // We also use internal links from discovered pages.
  //
  // To keep this Worker safe, we inspect only a limited number
  // of already discovered pages during the discovery stage.
  // ==========================================================

  const discoveryPages =
    Array.from(
      pages
    ).slice(
      0,
      Math.min(
        pages.size,
        20
      )
    );


  for (
    const pageUrl
    of discoveryPages
  ) {

    if (
      pages.size >=
      MAX_PAGES
    ) {
      break;
    }


    try {

      const html =
        await fetchHtml(
          pageUrl
        );


      const links =
        extractInternalLinks(
          html,
          website
        );


      internalLinksFound +=
        links.length;


      for (
        const link
        of links
      ) {

        if (
          pages.size >=
          MAX_PAGES
        ) {
          break;
        }


        pages.add(
          link
        );
      }


    } catch {

      // Ignore discovery failures.
    }
  }


  return {

    pages:
      Array.from(
        pages
      ),

    sitemaps_checked:
      checkedSitemaps.size,

    sitemap_errors:
      sitemapErrors,

    internal_links_found:
      internalLinksFound
  };
}


// ============================================================
// EXTRACT SITEMAP URLS FROM ROBOTS.TXT
// ============================================================

function extractSitemapUrls(
  robots
) {

  const output = [];


  const lines =
    String(
      robots || ""
    ).split(
      /\r?\n/
    );


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
// CHECK SAME ORIGIN
// ============================================================

function sameOrigin(
  website,
  page
) {

  try {

    const a =
      new URL(
        website
      );


    const b =
      new URL(
        page
      );


    return (
      a.origin ===
      b.origin
    );

  } catch {

    return false;
  }
}


// ============================================================
// CHECK HTML PAGE
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
      ".tif",
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

      // Code
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
// FETCH HTML
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
  // Some servers don't send content-type correctly.
  //
  // Only reject when the server clearly says it is NOT HTML.
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


  // ----------------------------------------------------------
  // Check Content-Length when available.
  // ----------------------------------------------------------

  const contentLength =
    Number(
      response.headers.get(
        "content-length"
      ) || 0
    );


  if (
    contentLength >
    MAX_HTML_BYTES
  ) {

    throw new Error(
      "HTML page is too large"
    );
  }


  const text =
    await response.text();


  if (
    text.length >
    MAX_HTML_BYTES
  ) {

    throw new Error(
      "HTML page is too large"
    );
  }


  return text;
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

        method:
          "GET",

        redirect:
          "follow",

        headers: {

          "User-Agent":
            "MRME-WebsiteCrawler/1.0",

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
// EXTRACT INTERNAL LINKS
// ============================================================

function extractInternalLinks(
  html,
  website
) {

  const output =
    new Set();


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;


  let match;


  let count = 0;


  while (
    (match =
      regex.exec(html))
  ) {

    if (
      count >=
      MAX_LINKS_PER_PAGE
    ) {
      break;
    }


    const rawHref =
      decodeHtmlEntities(
        match[1]
      ).trim();


    if (!rawHref) {
      continue;
    }


    // Ignore anchors.
    if (
      rawHref.startsWith("#")
    ) {
      continue;
    }


    // Ignore javascript/mail/tel.
    if (
      /^(javascript:|mailto:|tel:|sms:)/i.test(
        rawHref
      )
    ) {
      continue;
    }


    try {

      const absolute =
        new URL(
          rawHref,
          website
        );


      absolute.hash = "";


      if (
        absolute.protocol !==
          "http:" &&
        absolute.protocol !==
          "https:"
      ) {
        continue;
      }


      const normalized =
        normalizeUrl(
          absolute.href
        );


      if (!normalized) {
        continue;
      }


      if (
        !sameOrigin(
          website,
          normalized
        )
      ) {
        continue;
      }


      if (
        !isHtmlPage(
          normalized
        )
      ) {
        continue;
      }


      output.add(
        normalized
      );


      count++;

    } catch {

      // Invalid URL.
    }
  }


  return Array.from(
    output
  );
}


// ============================================================
// EXTRACT COMPLETE PAGE CONTENT
// ============================================================

function extractPageContent(
  html
) {

  let source =
    String(
      html || ""
    );


  // ----------------------------------------------------------
  // Extract JSON-LD BEFORE removing script tags.
  // ----------------------------------------------------------

  const jsonLd =
    extractJsonLd(
      source
    );


  // ----------------------------------------------------------
  // Extract internal links BEFORE cleaning.
  // ----------------------------------------------------------

  const links =
    extractUsefulLinks(
      source
    );


  // ----------------------------------------------------------
  // Remove useless sections.
  // ----------------------------------------------------------

  source =
    source.replace(

      /<(script|style|noscript|svg|canvas|iframe|nav|footer|aside|template)[^>]*>[\s\S]*?<\/\1>/gi,

      " "
    );


  // ----------------------------------------------------------
  // Extract H1-H6 sections.
  // ----------------------------------------------------------

  const sections =
    extractSections(
      source
    );


  // ----------------------------------------------------------
  // If there are no headings, also create a main-content
  // section from visible text.
  // ----------------------------------------------------------

  if (
    sections.length === 0
  ) {

    const bodyText =
      htmlToText(
        source
      );


    if (bodyText) {

      sections.push({

        heading:
          "page_content",

        text:
          bodyText
      });
    }
  }


  return {

    sections,

    jsonLd,

    links
  };
}


// ============================================================
// EXTRACT H1-H6 SECTIONS
// ============================================================

function extractSections(
  html
) {

  const matches = [];


  const headingRegex =
    /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;


  let match;


  while (
    (match =
      headingRegex.exec(html))
  ) {

    const heading =
      cleanText(
        htmlToText(
          match[2]
        )
      );


    if (!heading) {
      continue;
    }


    matches.push({

      level:
        Number(
          match[1].substring(1)
        ),

      heading,

      start:
        match.index,

      end:
        headingRegex.lastIndex
    });
  }


  const sections = [];


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
        : html.length;


    const rawContent =
      html.slice(
        contentStart,
        contentEnd
      );


    const text =
      cleanText(
        htmlToText(
          rawContent
        )
      );


    if (!text) {
      continue;
    }


    sections.push({

      heading:
        current.heading,

      text,

      level:
        current.level
    });
  }


  return sections;
}


// ============================================================
// EXTRACT JSON-LD
// ============================================================

function extractJsonLd(
  html
) {

  const output = [];


  const regex =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;


  let match;


  while (
    (match =
      regex.exec(html))
  ) {

    const raw =
      match[1]
        .trim();


    if (!raw) {
      continue;
    }


    try {

      const parsed =
        JSON.parse(
          raw
        );


      output.push(
        parsed
      );

    } catch {

      // Invalid JSON-LD.
    }
  }


  return output;
}


// ============================================================
// EXTRACT USEFUL LINKS
// ============================================================

function extractUsefulLinks(
  html
) {

  const output = [];


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;


  let match;


  while (
    (match =
      regex.exec(html))
  ) {

    const href =
      decodeHtmlEntities(
        match[1]
      ).trim();


    const text =
      cleanText(
        htmlToText(
          match[2]
        )
      );


    if (!href) {
      continue;
    }


    if (
      !text
    ) {
      continue;
    }


    if (
      /^(javascript:|mailto:|tel:|sms:|#)/i.test(
        href
      )
    ) {
      continue;
    }


    output.push({

      text,

      href

    });


    if (
      output.length >=
      MAX_LINKS_PER_PAGE
    ) {
      break;
    }
  }


  return output;
}


// ============================================================
// BUILD DATABASE ROWS
// ============================================================

function buildRows(
  applicationId,
  pageUrl,
  extracted
) {

  const rows = [];


  // ----------------------------------------------------------
  // SECTION CONTENT
  // ----------------------------------------------------------

  for (
    const section
    of extracted.sections
  ) {

    const heading =
      cleanFieldName(
        section.heading
      );


    const text =
      cleanText(
        section.text
      );


    if (
      !heading ||
      !text
    ) {
      continue;
    }


    rows.push({

      application_id:
        applicationId,

      field:
        heading,

      data:
        text,

      source_url:
        pageUrl
    });
  }


  // ----------------------------------------------------------
  // JSON-LD
  //
  // Store useful structured business information.
  // We don't save the entire JSON object as one field.
  // ----------------------------------------------------------

  const structured =
    extractUsefulJsonLdFields(
      extracted.jsonLd
    );


  for (
    const item
    of structured
  ) {

    if (
      !item.field ||
      !item.data
    ) {
      continue;
    }


    rows.push({

      application_id:
        applicationId,

      field:
        item.field,

      data:
        item.data,

      source_url:
        pageUrl
    });
  }


  // ----------------------------------------------------------
  // REMOVE DUPLICATE ROWS WITHIN THIS PAGE.
  // ----------------------------------------------------------

  return deduplicateRows(
    rows
  );
}


// ============================================================
// EXTRACT USEFUL JSON-LD FIELDS
// ============================================================

function extractUsefulJsonLdFields(
  blocks
) {

  const output = [];


  for (
    const block
    of blocks
  ) {

    processJsonLdObject(
      block,
      output
    );
  }


  return output;
}


// ============================================================
// PROCESS JSON-LD OBJECT
// ============================================================

function processJsonLdObject(
  value,
  output
) {

  if (
    !value
  ) {
    return;
  }


  // ----------------------------------------------------------
  // Array
  // ----------------------------------------------------------

  if (
    Array.isArray(value)
  ) {

    for (
      const item
      of value
    ) {

      processJsonLdObject(
        item,
        output
      );
    }


    return;
  }


  // ----------------------------------------------------------
  // Non-object
  // ----------------------------------------------------------

  if (
    typeof value !==
    "object"
  ) {
    return;
  }


  // ----------------------------------------------------------
  // @graph
  // ----------------------------------------------------------

  if (
    Array.isArray(
      value["@graph"]
    )
  ) {

    processJsonLdObject(
      value["@graph"],
      output
    );
  }


  // ----------------------------------------------------------
  // @type
  // ----------------------------------------------------------

  const type =
    value["@type"];


  // ----------------------------------------------------------
  // Business name
  // ----------------------------------------------------------

  if (
    value.name
  ) {

    addJsonField(
      output,
      "structured_business_name",
      value.name
    );
  }


  // ----------------------------------------------------------
  // Telephone
  // ----------------------------------------------------------

  if (
    value.telephone
  ) {

    addJsonField(
      output,
      "phone",
      value.telephone
    );
  }


  // ----------------------------------------------------------
  // Email
  // ----------------------------------------------------------

  if (
    value.email
  ) {

    addJsonField(
      output,
      "email",
      value.email
    );
  }


  // ----------------------------------------------------------
  // URL
  // ----------------------------------------------------------

  if (
    value.url
  ) {

    addJsonField(
      output,
      "website",
      value.url
    );
  }


  // ----------------------------------------------------------
  // Price range
  // ----------------------------------------------------------

  if (
    value.priceRange
  ) {

    addJsonField(
      output,
      "price_range",
      value.priceRange
    );
  }


  // ----------------------------------------------------------
  // Address
  // ----------------------------------------------------------

  if (
    value.address
  ) {

    const address =
      formatAddress(
        value.address
      );


    if (address) {

      addJsonField(
        output,
        "address",
        address
      );
    }
  }


  // ----------------------------------------------------------
  // Opening hours
  // ----------------------------------------------------------

  if (
    value.openingHours
  ) {

    addJsonField(
      output,
      "opening_hours",
      value.openingHours
    );
  }


  // ----------------------------------------------------------
  // Opening hours specification
  // ----------------------------------------------------------

  if (
    value.openingHoursSpecification
  ) {

    addJsonField(
      output,
      "opening_hours",
      value.openingHoursSpecification
    );
  }


  // ----------------------------------------------------------
  // SameAs social links
  // ----------------------------------------------------------

  if (
    Array.isArray(
      value.sameAs
    )
  ) {

    addJsonField(
      output,
      "social_profiles",
      value.sameAs
    );
  }


  // ----------------------------------------------------------
  // Service
  // ----------------------------------------------------------

  if (
    value.serviceType
  ) {

    addJsonField(
      output,
      "service_type",
      value.serviceType
    );
  }


  // ----------------------------------------------------------
  // Description
  // ----------------------------------------------------------

  if (
    value.description
  ) {

    addJsonField(
      output,
      "structured_description",
      value.description
    );
  }


  // ----------------------------------------------------------
  // Don't need type currently, but touching it makes it clear
  // that @type is intentionally available for future versions.
  // ----------------------------------------------------------

  void type;
}


// ============================================================
// ADD JSON FIELD
// ============================================================

function addJsonField(
  output,
  field,
  data
) {

  if (
    data === null ||
    data === undefined
  ) {
    return;
  }


  if (
    typeof data ===
    "string"
  ) {

    const value =
      cleanText(
        data
      );


    if (!value) {
      return;
    }


    output.push({

      field,

      data:
        value
    });


    return;
  }


  if (
    Array.isArray(data)
  ) {

    const values =
      data.filter(
        item =>
          item !== null &&
          item !== undefined &&
          item !== ""
      );


    if (
      values.length === 0
    ) {
      return;
    }


    output.push({

      field,

      data:
        values
    });


    return;
  }


  if (
    typeof data ===
    "object"
  ) {

    if (
      Object.keys(
        data
      ).length === 0
    ) {
      return;
    }


    output.push({

      field,

      data
    });
  }
}


// ============================================================
// FORMAT ADDRESS
// ============================================================

function formatAddress(
  address
) {

  if (
    typeof address ===
    "string"
  ) {

    return cleanText(
      address
    );
  }


  if (
    !address ||
    typeof address !==
      "object"
  ) {

    return null;
  }


  const parts = [

    address.streetAddress,

    address.addressLocality,

    address.addressRegion,

    address.postalCode,

    address.addressCountry

  ];


  const cleaned =
    parts
      .filter(
        value =>
          value !== null &&
          value !== undefined &&
          String(value).trim()
      )
      .map(
        value =>
          String(value).trim()
      );


  return cleaned.length
    ? cleaned.join(", ")
    : null;
}


// ============================================================
// CLEAN FIELD NAME
// ============================================================

function cleanFieldName(
  value
) {

  return String(
    value || ""
  )

    .trim()

    .toLowerCase()

    .replace(
      /[^a-z0-9]+/g,
      "_"
    )

    .replace(
      /^_+|_+$/g,
      ""
    )

    .slice(
      0,
      150
    );
}


// ============================================================
// CLEAN TEXT
// ============================================================

function cleanText(
  value
) {

  return String(
    value || ""
  )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


// ============================================================
// CONVERT HTML TO TEXT
// ============================================================

function htmlToText(
  html
) {

  let value =
    String(
      html || ""
    );


  // Remove comments.
  value =
    value.replace(
      /<!--[\s\S]*?-->/g,
      " "
    );


  // Turn common block elements into spaces.
  value =
    value.replace(

      /<(br|p|div|section|article|li|ul|ol|table|tr|td|th|blockquote|pre|address|figure|figcaption)[^>]*>/gi,

      " "
    );


  // Remove tags.
  value =
    value.replace(
      /<[^>]+>/g,
      " "
    );


  // Decode entities.
  value =
    decodeHtmlEntities(
      value
    );


  return cleanText(
    value
  );
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

    // Decimal HTML entities.
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

    // Hex HTML entities.
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
// DEDUPLICATE ROWS
// ============================================================

function deduplicateRows(
  rows
) {

  const output = [];


  const seen =
    new Set();


  for (
    const row
    of rows
  ) {

    const key =
      [
        row.application_id,
        row.source_url,
        row.field,
        JSON.stringify(
          row.data
        )
      ].join(
        "|"
      );


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(
      key
    );


    output.push(
      row
    );
  }


  return output;
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
    // IMPORTANT
    //
    // This requires:
    //
    // UNIQUE (
    //   application_id,
    //   source_url,
    //   field
    // )
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
