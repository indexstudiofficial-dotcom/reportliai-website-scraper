// ============================================================
// REPORTLI AI
// AI-FREE WEBSITE SCRAPER
// Cloudflare Worker
//
// INPUT:
//
// POST /
//
// {
//   "application_id": "app-123",
//   "domain": "https://example.com"
// }
//
// OR:
//
// {
//   "application_id": "app-123",
//   "website_url": "https://example.com"
// }
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

// Maximum pages processed in one Worker invocation.
//
// Increase this carefully because each page requires
// network requests to the website + Supabase.
const MAX_PAGES = 40;

// Maximum sitemap files we will inspect.
const MAX_SITEMAPS = 10;

// Maximum size of one downloaded HTML document.
const MAX_HTML_SIZE = 2_000_000;

// Maximum text stored for one page.
const MAX_TEXT_LENGTH = 30_000;

// Website request timeout.
const FETCH_TIMEOUT_MS = 12_000;


// ============================================================
// CORS
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS"
};


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    // --------------------------------------------------------
    // CORS preflight
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {

      return new Response("ok", {
        headers: CORS_HEADERS
      });

    }


    // --------------------------------------------------------
    // Only POST
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return jsonResponse(
        {
          error: "Only POST requests are allowed."
        },
        405
      );

    }


    try {

      // ------------------------------------------------------
      // Check environment variables
      // ------------------------------------------------------

      validateEnvironment(env);


      // ------------------------------------------------------
      // Read request body
      // ------------------------------------------------------

      const body =
        await request.json();


      // ------------------------------------------------------
      // application_id
      // ------------------------------------------------------

      const applicationId =
        body.application_id ||
        body.applicationId;


      // ------------------------------------------------------
      // Website URL
      // ------------------------------------------------------

      const websiteInput =
        body.domain ||
        body.website_url ||
        body.websiteUrl;


      if (!applicationId) {

        return jsonResponse(
          {
            error:
              "application_id is required."
          },
          400
        );

      }


      if (!websiteInput) {

        return jsonResponse(
          {
            error:
              "domain is required."
          },
          400
        );

      }


      // ------------------------------------------------------
      // Normalize URL
      // ------------------------------------------------------

      const websiteUrl =
        normalizeUrl(
          websiteInput
        );


      if (!websiteUrl) {

        return jsonResponse(
          {
            error:
              "Invalid website URL."
          },
          400
        );

      }


      // ------------------------------------------------------
      // SSRF protection
      // ------------------------------------------------------

      if (
        !isSafePublicUrl(
          websiteUrl
        )
      ) {

        return jsonResponse(
          {
            error:
              "This website URL is not allowed."
          },
          400
        );

      }


      // ------------------------------------------------------
      // Verify application
      // ------------------------------------------------------

      const applicationExists =
        await verifyApplication(
          env,
          applicationId
        );


      if (!applicationExists) {

        return jsonResponse(
          {
            error:
              "Application not found."
          },
          404
        );

      }


      // ------------------------------------------------------
      // Determine hostname
      // ------------------------------------------------------

      const website =
        new URL(
          websiteUrl
        );


      const hostname =
        website.hostname;


      // ------------------------------------------------------
      // Find sitemap
      // ------------------------------------------------------

      const sitemapUrls =
        await discoverSitemaps(
          websiteUrl
        );


      // ------------------------------------------------------
      // Discover URLs from sitemap
      // ------------------------------------------------------

      const sitemapPages =
        await crawlSitemaps(
          sitemapUrls,
          hostname
        );


      // ------------------------------------------------------
      // Crawl normal website links too
      //
      // Sitemap may not contain everything.
      // ------------------------------------------------------

      const discoveredPages =
        new Set();


      discoveredPages.add(
        websiteUrl
      );


      for (
        const page of sitemapPages
      ) {

        discoveredPages.add(
          page
        );

      }


      // ------------------------------------------------------
      // Keep only same-host pages
      // ------------------------------------------------------

      const initialPages =
        Array.from(
          discoveredPages
        )
        .filter(
          url =>
            isSameHostname(
              url,
              hostname
            )
        );


      // ------------------------------------------------------
      // Queue
      // ------------------------------------------------------

      const queue = [
        ...initialPages
      ];


      const queued =
        new Set(queue);


      const processed =
        new Set();


      let pagesProcessed = 0;

      let pagesFailed = 0;

      let fieldsSaved = 0;


      // ------------------------------------------------------
      // Crawl pages
      // ------------------------------------------------------

      while (
        queue.length > 0 &&
        pagesProcessed < MAX_PAGES
      ) {

        const pageUrl =
          queue.shift();


        if (!pageUrl) {
          continue;
        }


        if (
          processed.has(
            pageUrl
          )
        ) {

          continue;

        }


        processed.add(
          pageUrl
        );


        console.log(
          `Processing ${pagesProcessed + 1}/${MAX_PAGES}: ${pageUrl}`
        );


        try {

          // --------------------------------------------------
          // Fetch HTML
          // --------------------------------------------------

          const html =
            await fetchHtml(
              pageUrl
            );


          if (!html) {

            pagesFailed++;

            continue;

          }


          // --------------------------------------------------
          // Extract everything we can without AI
          // --------------------------------------------------

          const extracted =
            extractWebsiteData(
              html,
              pageUrl
            );


          // --------------------------------------------------
          // Save page information
          // --------------------------------------------------

          const saved =
            await saveExtractedData(
              env,
              applicationId,
              pageUrl,
              extracted
            );


          fieldsSaved +=
            saved;


          pagesProcessed++;


          // --------------------------------------------------
          // Discover links from this page
          // --------------------------------------------------

          const links =
            extractInternalLinks(
              html,
              pageUrl,
              hostname
            );


          for (
            const link of links
          ) {

            if (
              queue.length +
              processed.size >=
              MAX_PAGES * 2
            ) {

              break;

            }


            if (
              processed.has(
                link
              )
            ) {

              continue;

            }


            if (
              queued.has(
                link
              )
            ) {

              continue;

            }


            queued.add(
              link
            );


            queue.push(
              link
            );

          }

        } catch (error) {

          console.error(
            "Page processing failed:",
            pageUrl,
            error
          );

          pagesFailed++;

        }

      }


      // ------------------------------------------------------
      // Response
      // ------------------------------------------------------

      return jsonResponse(
        {
          success: true,

          application_id:
            applicationId,

          website:
            websiteUrl,

          hostname:
            hostname,

          sitemaps_found:
            sitemapUrls.length,

          sitemap_pages_found:
            sitemapPages.length,

          pages_processed:
            pagesProcessed,

          pages_failed:
            pagesFailed,

          fields_saved:
            fieldsSaved,

          max_pages:
            MAX_PAGES,

          message:
            "Website data extraction completed without AI."
        },
        200
      );


    } catch (error) {

      console.error(
        "Worker error:",
        error
      );


      return jsonResponse(
        {
          success: false,

          error:
            error instanceof Error
              ? error.message
              : "Unknown error."
        },
        500
      );

    }

  }

};


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {

  if (!env.SUPABASE_URL) {

    throw new Error(
      "SUPABASE_URL secret is missing."
    );

  }


  if (!env.SUPABASE_SECRET_KEY) {

    throw new Error(
      "SUPABASE_SECRET_KEY secret is missing."
    );

  }

}


// ============================================================
// VERIFY APPLICATION
// ============================================================

async function verifyApplication(
  env,
  applicationId
) {

  const url =
    `${env.SUPABASE_URL}` +
    `/rest/v1/applications` +
    `?id=eq.${encodeURIComponent(applicationId)}` +
    `&select=id`;


  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          "apikey":
            env.SUPABASE_SECRET_KEY,

          "Authorization":
            `Bearer ${env.SUPABASE_SECRET_KEY}`
        }
      }
    );


  if (!response.ok) {

    console.error(
      "Application verification failed:",
      await response.text()
    );

    throw new Error(
      "Could not verify application."
    );

  }


  const data =
    await response.json();


  return (
    Array.isArray(data) &&
    data.length > 0
  );

}


// ============================================================
// DISCOVER SITEMAPS
// ============================================================

async function discoverSitemaps(
  websiteUrl
) {

  const website =
    new URL(
      websiteUrl
    );


  const candidates = [];


  // ----------------------------------------------------------
  // Standard sitemap location
  // ----------------------------------------------------------

  candidates.push(
    new URL(
      "/sitemap.xml",
      website.origin
    ).href
  );


  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  try {

    const robotsUrl =
      new URL(
        "/robots.txt",
        website.origin
      ).href;


    const robots =
      await fetchText(
        robotsUrl
      );


    if (robots) {

      const lines =
        robots.split(/\r?\n/);


      for (
        const line of lines
      ) {

        const match =
          line.match(
            /^\s*sitemap\s*:\s*(.+)\s*$/i
          );


        if (match) {

          const sitemap =
            normalizeUrl(
              match[1]
            );


          if (sitemap) {

            candidates.push(
              sitemap
            );

          }

        }

      }

    }

  } catch (error) {

    console.error(
      "robots.txt failed:",
      error
    );

  }


  // ----------------------------------------------------------
  // Remove duplicates
  // ----------------------------------------------------------

  return [
    ...new Set(
      candidates
    )
  ]
  .slice(
    0,
    MAX_SITEMAPS
  );

}


// ============================================================
// CRAWL SITEMAPS
// ============================================================

async function crawlSitemaps(
  sitemapUrls,
  hostname
) {

  const pages =
    new Set();


  const sitemapQueue =
    [...sitemapUrls];


  const processedSitemaps =
    new Set();


  while (
    sitemapQueue.length > 0 &&
    processedSitemaps.size < MAX_SITEMAPS
  ) {

    const sitemapUrl =
      sitemapQueue.shift();


    if (!sitemapUrl) {
      continue;
    }


    if (
      processedSitemaps.has(
        sitemapUrl
      )
    ) {

      continue;

    }


    processedSitemaps.add(
      sitemapUrl
    );


    try {

      const xml =
        await fetchText(
          sitemapUrl
        );


      if (!xml) {
        continue;
      }


      // ------------------------------------------------------
      // Sitemap index
      // ------------------------------------------------------

      const sitemapMatches =
        xml.matchAll(
          /<sitemap>\s*[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>\s*[\s\S]*?<\/sitemap>/gi
        );


      for (
        const match of sitemapMatches
      ) {

        const child =
          normalizeUrl(
            decodeXml(
              match[1]
            )
          );


        if (
          child &&
          !processedSitemaps.has(
            child
          ) &&
          sitemapQueue.length <
            MAX_SITEMAPS
        ) {

          sitemapQueue.push(
            child
          );

        }

      }


      // ------------------------------------------------------
      // URL entries
      // ------------------------------------------------------

      const urlMatches =
        xml.matchAll(
          /<url>\s*[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>\s*[\s\S]*?<\/url>/gi
        );


      for (
        const match of urlMatches
      ) {

        const page =
          normalizeUrl(
            decodeXml(
              match[1]
            )
          );


        if (
          page &&
          isSameHostname(
            page,
            hostname
          ) &&
          isProbablyHtmlUrl(
            page
          )
        ) {

          pages.add(
            page
          );

        }

      }

    } catch (error) {

      console.error(
        "Sitemap failed:",
        sitemapUrl,
        error
      );

    }

  }


  return Array.from(
    pages
  );

}


// ============================================================
// FETCH HTML
// ============================================================

async function fetchHtml(
  url
) {

  try {

    const controller =
      new AbortController();


    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        FETCH_TIMEOUT_MS
      );


    const response =
      await fetch(
        url,
        {
          method: "GET",

          redirect: "follow",

          headers: {
            "User-Agent":
              "ReportliAI-Crawler/1.0",

            "Accept":
              "text/html,application/xhtml+xml"
          },

          signal:
            controller.signal
        }
      );


    clearTimeout(
      timeout
    );


    if (!response.ok) {

      return null;

    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    if (
      !contentType.includes(
        "text/html"
      ) &&
      !contentType.includes(
        "application/xhtml+xml"
      )
    ) {

      return null;

    }


    const html =
      await response.text();


    if (
      html.length >
      MAX_HTML_SIZE
    ) {

      return html.substring(
        0,
        MAX_HTML_SIZE
      );

    }


    return html;

  } catch (error) {

    console.error(
      "HTML fetch failed:",
      url,
      error
    );


    return null;

  }

}


// ============================================================
// FETCH TEXT
// ============================================================

async function fetchText(
  url
) {

  try {

    const controller =
      new AbortController();


    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        FETCH_TIMEOUT_MS
      );


    const response =
      await fetch(
        url,
        {
          method: "GET",

          redirect: "follow",

          headers: {
            "User-Agent":
              "ReportliAI-Crawler/1.0"
          },

          signal:
            controller.signal
        }
      );


    clearTimeout(
      timeout
    );


    if (!response.ok) {
      return null;
    }


    return await response.text();

  } catch {

    return null;

  }

}


// ============================================================
// EXTRACT WEBSITE DATA
// ============================================================

function extractWebsiteData(
  html,
  sourceUrl
) {

  const result = {};


  // ----------------------------------------------------------
  // PAGE TITLE
  // ----------------------------------------------------------

  const title =
    extractFirst(
      html,
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );


  if (title) {

    result.page_title =
      cleanText(
        decodeHtmlEntities(
          title
        )
      );

  }


  // ----------------------------------------------------------
  // META DESCRIPTION
  // ----------------------------------------------------------

  const description =
    extractMeta(
      html,
      "description"
    );


  if (description) {

    result.page_description =
      description;

  }


  // ----------------------------------------------------------
  // OG TITLE
  // ----------------------------------------------------------

  const ogTitle =
    extractMetaProperty(
      html,
      "og:title"
    );


  if (ogTitle) {

    result.og_title =
      ogTitle;

  }


  // ----------------------------------------------------------
  // OG DESCRIPTION
  // ----------------------------------------------------------

  const ogDescription =
    extractMetaProperty(
      html,
      "og:description"
    );


  if (ogDescription) {

    result.og_description =
      ogDescription;

  }


  // ----------------------------------------------------------
  // CANONICAL URL
  // ----------------------------------------------------------

  const canonical =
    extractCanonical(
      html
    );


  if (canonical) {

    result.canonical_url =
      canonical;

  }


  // ----------------------------------------------------------
  // HEADINGS
  // ----------------------------------------------------------

  const headings =
    extractHeadings(
      html
    );


  if (
    headings.length > 0
  ) {

    result.headings =
      headings;

  }


  // ----------------------------------------------------------
  // JSON-LD / Schema.org
  // ----------------------------------------------------------

  const jsonLd =
    extractJsonLd(
      html
    );


  if (
    jsonLd.length > 0
  ) {

    result.schema_org =
      jsonLd;

    // --------------------------------------------------------
    // Pull useful business fields from Schema.org
    // --------------------------------------------------------

    extractSchemaFields(
      jsonLd,
      result
    );

  }


  // ----------------------------------------------------------
  // PHONE NUMBERS
  // ----------------------------------------------------------

  const phones =
    extractPhones(
      html
    );


  if (
    phones.length > 0
  ) {

    result.phone =
      unique(
        phones
      );

  }


  // ----------------------------------------------------------
  // EMAIL ADDRESSES
  // ----------------------------------------------------------

  const emails =
    extractEmails(
      html
    );


  if (
    emails.length > 0
  ) {

    result.email =
      unique(
        emails
      );

  }


  // ----------------------------------------------------------
  // OPENING HOURS
  // ----------------------------------------------------------

  const openingHours =
    extractOpeningHours(
      html
    );


  if (
    openingHours.length > 0
  ) {

    result.opening_hours =
      unique(
        openingHours
      );

  }


  // ----------------------------------------------------------
  // SOCIAL LINKS
  // ----------------------------------------------------------

  const socialLinks =
    extractSocialLinks(
      html,
      sourceUrl
    );


  if (
    socialLinks.length > 0
  ) {

    result.social_links =
      unique(
        socialLinks
      );

  }


  // ----------------------------------------------------------
  // MAIN PAGE TEXT
  // ----------------------------------------------------------

  const text =
    extractReadableText(
      html
    );


  if (text) {

    result.page_content =
      text.substring(
        0,
        MAX_TEXT_LENGTH
      );

  }


  return result;

}


// ============================================================
// EXTRACT JSON-LD
// ============================================================

function extractJsonLd(
  html
) {

  const scripts = [];


  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;


  let match;


  while (
    (match = regex.exec(html))
  ) {

    const raw =
      match[1].trim();


    if (!raw) {
      continue;
    }


    try {

      const parsed =
        JSON.parse(
          raw
        );


      if (
        Array.isArray(
          parsed
        )
      ) {

        scripts.push(
          ...parsed
        );

      } else {

        scripts.push(
          parsed
        );

      }

    } catch {

      // Some websites contain invalid JSON-LD.
      // Ignore it instead of failing the page.

    }

  }


  return scripts;

}


// ============================================================
// EXTRACT SCHEMA FIELDS
// ============================================================

function extractSchemaFields(
  jsonLd,
  result
) {

  const objects =
    flattenSchemaObjects(
      jsonLd
    );


  for (
    const object
    of objects
  ) {

    const type =
      getSchemaType(
        object
      );


    // --------------------------------------------------------
    // Business name
    // --------------------------------------------------------

    if (
      !result.business_name &&
      object.name &&
      isBusinessSchemaType(
        type
      )
    ) {

      result.business_name =
        cleanValue(
          object.name
        );

    }


    // --------------------------------------------------------
    // Description
    // --------------------------------------------------------

    if (
      !result.business_description &&
      object.description
    ) {

      result.business_description =
        cleanValue(
          object.description
        );

    }


    // --------------------------------------------------------
    // Telephone
    // --------------------------------------------------------

    if (
      !result.phone &&
      object.telephone
    ) {

      result.phone =
        [
          cleanValue(
            object.telephone
          )
        ];

    }


    // --------------------------------------------------------
    // Email
    // --------------------------------------------------------

    if (
      !result.email &&
      object.email
    ) {

      result.email =
        [
          cleanValue(
            object.email
          )
        ];

    }


    // --------------------------------------------------------
    // Address
    // --------------------------------------------------------

    if (
      !result.address &&
      object.address
    ) {

      result.address =
        normalizeAddress(
          object.address
        );

    }


    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    if (
      !result.business_website &&
      object.url
    ) {

      result.business_website =
        cleanValue(
          object.url
        );

    }


    // --------------------------------------------------------
    // Opening hours
    // --------------------------------------------------------

    if (
      !result.opening_hours &&
      object.openingHours
    ) {

      result.opening_hours =
        cleanValue(
          object.openingHours
        );

    }


    // --------------------------------------------------------
    // Price range
    // --------------------------------------------------------

    if (
      !result.price_range &&
      object.priceRange
    ) {

      result.price_range =
        cleanValue(
          object.priceRange
        );

    }


    // --------------------------------------------------------
    // Services
    // --------------------------------------------------------

    if (
      !result.services &&
      object.hasOfferCatalog
    ) {

      result.services =
        extractOfferCatalog(
          object.hasOfferCatalog
        );

    }


    // --------------------------------------------------------
    // Products
    // --------------------------------------------------------

    if (
      !result.products &&
      object.itemListElement
    ) {

      const products =
        extractItems(
          object.itemListElement
        );


      if (
        products.length > 0
      ) {

        result.products =
          products;

      }

    }

  }

}


// ============================================================
// FLATTEN SCHEMA OBJECTS
// ============================================================

function flattenSchemaObjects(
  input
) {

  const result = [];


  function walk(value) {

    if (!value) {
      return;
    }


    if (
      Array.isArray(
        value
      )
    ) {

      for (
        const item
        of value
      ) {

        walk(item);

      }

      return;

    }


    if (
      typeof value !==
      "object"
    ) {

      return;

    }


    result.push(
      value
    );


    if (
      value["@graph"]
    ) {

      walk(
        value["@graph"]
      );

    }

  }


  walk(
    input
  );


  return result;

}


// ============================================================
// SCHEMA TYPE
// ============================================================

function getSchemaType(
  object
) {

  const type =
    object?.["@type"];


  if (
    Array.isArray(
      type
    )
  ) {

    return type.join(
      ","
    );

  }


  return String(
    type || ""
  );

}


// ============================================================
// BUSINESS SCHEMA TYPE
// ============================================================

function isBusinessSchemaType(
  type
) {

  const value =
    String(
      type
    ).toLowerCase();


  return (
    value.includes(
      "business"
    ) ||
    value.includes(
      "organization"
    ) ||
    value.includes(
      "restaurant"
    ) ||
    value.includes(
      "medicalorganization"
    ) ||
    value.includes(
      "localbusiness"
    ) ||
    value.includes(
      "store"
    ) ||
    value.includes(
      "clinic"
    ) ||
    value.includes(
      "dentist"
    ) ||
    value.includes(
      "physician"
    )
  );

}


// ============================================================
// NORMALIZE ADDRESS
// ============================================================

function normalizeAddress(
  address
) {

  if (
    typeof address ===
    "string"
  ) {

    return address;

  }


  if (
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
  ]
  .filter(Boolean);


  return parts.join(
    ", "
  );

}


// ============================================================
// EXTRACT OFFER CATALOG
// ============================================================

function extractOfferCatalog(
  catalog
) {

  const results = [];


  function walk(value) {

    if (!value) {
      return;
    }


    if (
      Array.isArray(
        value
      )
    ) {

      for (
        const item
        of value
      ) {

        walk(item);

      }

      return;

    }


    if (
      typeof value !==
      "object"
    ) {

      return;

    }


    if (
      value.name
    ) {

      results.push(
        {
          name:
            cleanValue(
              value.name
            ),

          description:
            cleanValue(
              value.description
            ),

          price:
            cleanValue(
              value.price
            )
        }
      );

    }


    if (
      value.itemListElement
    ) {

      walk(
        value.itemListElement
      );

    }


    if (
      value.hasOfferCatalog
    ) {

      walk(
        value.hasOfferCatalog
      );

    }

  }


  walk(
    catalog
  );


  return results;

}


// ============================================================
// EXTRACT ITEMS
// ============================================================

function extractItems(
  items
) {

  const results = [];


  if (
    !Array.isArray(
      items
    )
  ) {

    return results;

  }


  for (
    const item
    of items
  ) {

    const value =
      item?.item ||
      item;


    if (
      value &&
      typeof value ===
      "object"
    ) {

      results.push(
        {
          name:
            cleanValue(
              value.name
            ),

          description:
            cleanValue(
              value.description
            ),

          url:
            cleanValue(
              value.url
            )
        }
      );

    }

  }


  return results;

}


// ============================================================
// EXTRACT META
// ============================================================

function extractMeta(
  html,
  name
) {

  const regex =
    new RegExp(
      `<meta[^>]+name=["']${escapeRegex(name)}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    );


  const reverseRegex =
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escapeRegex(name)}["'][^>]*>`,
      "i"
    );


  const match =
    html.match(
      regex
    ) ||
    html.match(
      reverseRegex
    );


  return match
    ? cleanText(
        decodeHtmlEntities(
          match[1]
        )
      )
    : null;

}


// ============================================================
// EXTRACT OG META
// ============================================================

function extractMetaProperty(
  html,
  property
) {

  const regex =
    new RegExp(
      `<meta[^>]+property=["']${escapeRegex(property)}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    );


  const reverseRegex =
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escapeRegex(property)}["'][^>]*>`,
      "i"
    );


  const match =
    html.match(
      regex
    ) ||
    html.match(
      reverseRegex
    );


  return match
    ? cleanText(
        decodeHtmlEntities(
          match[1]
        )
      )
    : null;

}


// ============================================================
// EXTRACT CANONICAL
// ============================================================

function extractCanonical(
  html
) {

  const regex =
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i;


  const reverseRegex =
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i;


  const match =
    html.match(
      regex
    ) ||
    html.match(
      reverseRegex
    );


  return match
    ? match[1]
    : null;

}


// ============================================================
// EXTRACT HEADINGS
// ============================================================

function extractHeadings(
  html
) {

  const headings = [];


  const regex =
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;


  let match;


  while (
    (match = regex.exec(html))
  ) {

    const text =
      cleanText(
        stripTags(
          match[2]
        )
      );


    if (text) {

      headings.push(
        {
          level:
            Number(
              match[1]
            ),

          text:
            text
        }
      );

    }

  }


  return headings;

}


// ============================================================
// EXTRACT PHONE NUMBERS
// ============================================================

function extractPhones(
  html
) {

  const text =
    decodeHtmlEntities(
      stripTags(
        html
      )
    );


  const matches =
    text.match(
      /(?:\+?\d[\d\s().-]{7,}\d)/g
    ) || [];


  return matches
    .map(
      phone =>
        phone
          .replace(
            /\s+/g,
            " "
          )
          .trim()
    )
    .filter(
      phone =>
        phone.replace(
          /\D/g,
          ""
        ).length >= 8
    );

}


// ============================================================
// EXTRACT EMAILS
// ============================================================

function extractEmails(
  html
) {

  const text =
    decodeHtmlEntities(
      html
    );


  const matches =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
    ) || [];


  return matches.map(
    email =>
      email.toLowerCase()
  );

}


// ============================================================
// EXTRACT OPENING HOURS
// ============================================================

function extractOpeningHours(
  html
) {

  const text =
    cleanText(
      stripTags(
        decodeHtmlEntities(
          html
        )
      )
    );


  const results = [];


  const dayPattern =
    "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)";


  const regex =
    new RegExp(
      `${dayPattern}[\\s:-]{0,5}(?:[A-Za-z]+\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM|am|pm)?\\s*(?:-|–|to)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM|am|pm)?`,
      "gi"
    );


  let match;


  while (
    (match = regex.exec(text))
  ) {

    results.push(
      match[0]
    );

  }


  return results;

}


// ============================================================
// EXTRACT SOCIAL LINKS
// ============================================================

function extractSocialLinks(
  html,
  sourceUrl
) {

  const links =
    extractAllLinks(
      html,
      sourceUrl
    );


  const socialDomains = [
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "tiktok.com",
    "threads.net",
    "wa.me",
    "whatsapp.com"
  ];


  return links.filter(
    link => {

      try {

        const hostname =
          new URL(
            link
          ).hostname.toLowerCase();


        return socialDomains.some(
          domain =>
            hostname === domain ||
            hostname.endsWith(
              "." + domain
            )
        );

      } catch {

        return false;

      }

    }
  );

}


// ============================================================
// EXTRACT INTERNAL LINKS
// ============================================================

function extractInternalLinks(
  html,
  currentUrl,
  hostname
) {

  return extractAllLinks(
    html,
    currentUrl
  )
  .filter(
    link =>
      isSameHostname(
        link,
        hostname
      )
  )
  .filter(
    isProbablyHtmlUrl
  );

}


// ============================================================
// EXTRACT ALL LINKS
// ============================================================

function extractAllLinks(
  html,
  currentUrl
) {

  const results =
    new Set();


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;


  let match;


  while (
    (match = regex.exec(html))
  ) {

    const href =
      match[1];


    try {

      if (
        href.startsWith(
          "#"
        ) ||
        href.startsWith(
          "mailto:"
        ) ||
        href.startsWith(
          "tel:"
        ) ||
        href.startsWith(
          "javascript:"
        )
      ) {

        continue;

      }


      const absolute =
        new URL(
          href,
          currentUrl
        );


      if (
        absolute.protocol !==
          "http:" &&
        absolute.protocol !==
          "https:"
      ) {

        continue;

      }


      absolute.hash =
        "";


      // ------------------------------------------------------
      // Remove tracking parameters
      // ------------------------------------------------------

      const tracking =
        [
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "utm_term",
          "utm_content",
          "fbclid",
          "gclid"
        ];


      for (
        const parameter
        of tracking
      ) {

        absolute.searchParams.delete(
          parameter
        );

      }


      const normalized =
        normalizeUrl(
          absolute.href
        );


      if (normalized) {

        results.add(
          normalized
        );

      }

    } catch {

      // Ignore malformed URLs.

    }

  }


  return Array.from(
    results
  );

}


// ============================================================
// EXTRACT READABLE TEXT
// ============================================================

function extractReadableText(
  html
) {

  let text =
    html;


  // Remove scripts.
  text =
    text.replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    );


  // Remove styles.
  text =
    text.replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    );


  // Remove SVG.
  text =
    text.replace(
      /<svg[\s\S]*?<\/svg>/gi,
      " "
    );


  // Remove noscript.
  text =
    text.replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " "
    );


  // Remove comments.
  text =
    text.replace(
      /<!--[\s\S]*?-->/g,
      " "
    );


  // Remove tags.
  text =
    text.replace(
      /<[^>]+>/g,
      " "
    );


  // Decode entities.
  text =
    decodeHtmlEntities(
      text
    );


  // Normalize whitespace.
  text =
    text.replace(
      /\s+/g,
      " "
    );


  return text.trim();

}


// ============================================================
// SAVE EXTRACTED DATA
// ============================================================

async function saveExtractedData(
  env,
  applicationId,
  sourceUrl,
  extracted
) {

  let saved = 0;


  for (
    const [field, value]
    of Object.entries(
      extracted
    )
  ) {

    if (
      value === undefined ||
      value === null
    ) {

      continue;

    }


    if (
      typeof value ===
      "string" &&
      !value.trim()
    ) {

      continue;

    }


    // --------------------------------------------------------
    // Do not store the entire schema JSON as one enormous field
    // if it is empty.
    // --------------------------------------------------------

    const payload = {

      application_id:
        applicationId,

      field:
        field,

      data:
        value,

      source_url:
        sourceUrl,

      updated_at:
        new Date().toISOString()

    };


    const url =
      `${env.SUPABASE_URL}` +
      `/rest/v1/business_data` +
      `?on_conflict=application_id,field`;


    const response =
      await fetch(
        url,
        {
          method: "POST",

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
              payload
            )
        }
      );


    if (!response.ok) {

      console.error(
        "Supabase save failed:",
        field,
        await response.text()
      );


      continue;

    }


    saved++;

  }


  return saved;

}


// ============================================================
// URL NORMALIZATION
// ============================================================

function normalizeUrl(
  input
) {

  try {

    let value =
      String(
        input
      ).trim();


    if (
      !value.startsWith(
        "http://"
      ) &&
      !value.startsWith(
        "https://"
      )
    ) {

      value =
        "https://" +
        value;

    }


    const url =
      new URL(
        value
      );


    if (
      url.protocol !==
        "http:" &&
      url.protocol !==
        "https:"
    ) {

      return null;

    }


    url.hash =
      "";


    const tracking =
      [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid"
      ];


    for (
      const parameter
      of tracking
    ) {

      url.searchParams.delete(
        parameter
      );

    }


    if (
      url.pathname !==
      "/"
    ) {

      url.pathname =
        url.pathname.replace(
          /\/+$/,
          ""
        );

    }


    return url.href;

  } catch {

    return null;

  }

}


// ============================================================
// SAME HOSTNAME
// ============================================================

function isSameHostname(
  url,
  hostname
) {

  try {

    return (
      new URL(
        url
      ).hostname.toLowerCase() ===
      hostname.toLowerCase()
    );

  } catch {

    return false;

  }

}


// ============================================================
// HTML URL CHECK
// ============================================================

function isProbablyHtmlUrl(
  url
) {

  try {

    const pathname =
      new URL(
        url
      ).pathname.toLowerCase();


    const ignoredExtensions = [

      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".svg",
      ".ico",

      ".pdf",

      ".zip",

      ".rar",

      ".7z",

      ".mp3",
      ".mp4",
      ".wav",
      ".avi",
      ".mov",

      ".css",
      ".js",

      ".json",

      ".xml",

      ".csv",

      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",

      ".woff",
      ".woff2",
      ".ttf",
      ".eot"

    ];


    return !ignoredExtensions.some(
      extension =>
        pathname.endsWith(
          extension
        )
    );

  } catch {

    return false;

  }

}


// ============================================================
// SSRF PROTECTION
// ============================================================

function isSafePublicUrl(
  urlString
) {

  try {

    const url =
      new URL(
        urlString
      );


    const hostname =
      url.hostname.toLowerCase();


    // --------------------------------------------------------
    // Localhost
    // --------------------------------------------------------

    if (
      hostname ===
        "localhost" ||
      hostname ===
        "localhost.localdomain"
    ) {

      return false;

    }


    // --------------------------------------------------------
    // Local domains
    // --------------------------------------------------------

    if (
      hostname.endsWith(
        ".local"
      ) ||
      hostname.endsWith(
        ".internal"
      )
    ) {

      return false;

    }


    // --------------------------------------------------------
    // IPv4
    // --------------------------------------------------------

    const parts =
      hostname.split(".");


    if (
      parts.length === 4 &&
      parts.every(
        part =>
          /^\d+$/.test(
            part
          )
      )
    ) {

      const [
        a,
        b
      ] =
        parts.map(
          Number
        );


      // 10.0.0.0/8
      if (
        a === 10
      ) {

        return false;

      }


      // 127.0.0.0/8
      if (
        a === 127
      ) {

        return false;

      }


      // 172.16.0.0/12
      if (
        a === 172 &&
        b >= 16 &&
        b <= 31
      ) {

        return false;

      }


      // 192.168.0.0/16
      if (
        a === 192 &&
        b === 168
      ) {

        return false;

      }


      // 169.254.0.0/16
      if (
        a === 169 &&
        b === 254
      ) {

        return false;

      }


      // 0.0.0.0/8
      if (
        a === 0
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
// HTML / TEXT HELPERS
// ============================================================

function stripTags(
  value
) {

  return String(
    value || ""
  ).replace(
    /<[^>]*>/g,
    " "
  );

}


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


function cleanValue(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;

  }


  if (
    typeof value ===
    "string"
  ) {

    return cleanText(
      value
    );

  }


  return value;

}


function extractFirst(
  text,
  regex
) {

  const match =
    text.match(
      regex
    );


  return match
    ? match[1]
    : null;

}


function decodeHtmlEntities(
  text
) {

  return String(
    text || ""
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

  .replace(
    /&#(\d+);/g,
    (_, number) =>
      String.fromCharCode(
        Number(
          number
        )
      )
  );

}


function decodeXml(
  text
) {

  return decodeHtmlEntities(
    text
  );

}


function escapeRegex(
  text
) {

  return String(
    text
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

}


function unique(
  array
) {

  return [
    ...new Set(
      array
    )
  ];

}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(
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
        ...CORS_HEADERS,

        "Content-Type":
          "application/json"
      }
    }
  );

  }
