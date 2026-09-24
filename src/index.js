// ============================================================
// REPORTLI AI
// WEBSITE KNOWLEDGE EXTRACTOR
//
// CLOUDFLARE WORKER
// SUPABASE + SARVAM 105B
//
// ENVIRONMENT VARIABLES:
//
// SUPABASE_URL
// SUPABASE_SECRET_KEY
// SARVAM_API_KEY
//
// INPUT:
//
// {
//   "application_id": "app-123",
//   "domain": "https://example.com",
//   "max_pages": 5,
//   "page_offset": 0
// }
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {

  // ----------------------------------------------------------
  // How many pages to process in one Worker request
  // ----------------------------------------------------------

  DEFAULT_MAX_PAGES: 5,

  MAX_PAGES_PER_REQUEST: 10,


  // ----------------------------------------------------------
  // Website limits
  // ----------------------------------------------------------

  MAX_HTML_BYTES: 2_000_000,

  MAX_DISCOVERED_URLS: 500,

  MAX_SITEMAPS: 20,


  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // Do NOT send an entire webpage to Sarvam.
  //
  // Smaller chunks make extraction much more reliable.
  // ----------------------------------------------------------

  CHUNK_SIZE: 6000,

  CHUNK_OVERLAP: 500,

  MAX_CHUNKS_PER_PAGE: 50,


  // ----------------------------------------------------------
  // Request timeout
  // ----------------------------------------------------------

  WEBSITE_TIMEOUT: 15000,

  SARVAM_TIMEOUT: 60000,


  // ----------------------------------------------------------
  // Sarvam
  // ----------------------------------------------------------

  SARVAM_URL:
    "https://api.sarvam.ai/v1/chat/completions",

  SARVAM_MODEL:
    "sarvam-105b"
};


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env) {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });

    }


    // --------------------------------------------------------
    // POST ONLY
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return jsonResponse(
        {
          success: false,
          error: "Only POST requests are allowed."
        },
        405
      );

    }


    try {

      // ======================================================
      // CHECK ENVIRONMENT
      // ======================================================

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

      if (!env.SARVAM_API_KEY) {

        throw new Error(
          "SARVAM_API_KEY secret is missing."
        );

      }


      // ======================================================
      // READ BODY
      // ======================================================

      const body =
        await request.json();


      const applicationId =
        body.application_id ||
        body.applicationId;


      const websiteInput =
        body.domain ||
        body.website_url ||
        body.websiteUrl;


      if (!applicationId) {

        return jsonResponse(
          {
            success: false,
            error:
              "application_id is required."
          },
          400
        );

      }


      if (!websiteInput) {

        return jsonResponse(
          {
            success: false,
            error:
              "domain or website_url is required."
          },
          400
        );

      }


      // ======================================================
      // PAGE BATCH
      // ======================================================

      let maxPages =
        Number(body.max_pages) ||
        CONFIG.DEFAULT_MAX_PAGES;


      maxPages =
        Math.max(
          1,
          Math.min(
            maxPages,
            CONFIG.MAX_PAGES_PER_REQUEST
          )
        );


      let pageOffset =
        Number(body.page_offset) || 0;


      pageOffset =
        Math.max(
          0,
          pageOffset
        );


      // ======================================================
      // NORMALIZE WEBSITE
      // ======================================================

      const websiteUrl =
        normalizeWebsiteUrl(
          websiteInput
        );


      // ======================================================
      // VERIFY APPLICATION
      // ======================================================

      const application =
        await getApplication(
          env,
          applicationId
        );


      if (!application) {

        return jsonResponse(
          {
            success: false,
            error:
              "Application not found."
          },
          404
        );

      }


      // ======================================================
      // DISCOVER PAGES
      // ======================================================

      const discovery =
        await discoverPages(
          websiteUrl
        );


      const allPages =
        discovery.urls;


      // ======================================================
      // SELECT CURRENT BATCH
      // ======================================================

      const pages =
        allPages.slice(
          pageOffset,
          pageOffset + maxPages
        );


      // ======================================================
      // STATS
      // ======================================================

      const stats = {

        pages_discovered:
          allPages.length,

        pages_selected:
          pages.length,

        pages_processed:
          0,

        pages_failed:
          0,

        chunks_sent_to_ai:
          0,

        fields_extracted:
          0,

        fields_saved:
          0,

        fields_failed:
          0,

        sarvam_errors:
          0

      };


      const pageResults = [];


      // ======================================================
      // PROCESS EACH PAGE
      // ======================================================

      for (const pageUrl of pages) {

        try {

          const result =
            await processPage(
              env,
              applicationId,
              pageUrl
            );


          stats.pages_processed++;


          stats.chunks_sent_to_ai +=
            result.chunks_sent_to_ai;


          stats.fields_extracted +=
            result.fields_extracted;


          stats.fields_saved +=
            result.fields_saved;


          stats.fields_failed +=
            result.fields_failed;


          stats.sarvam_errors +=
            result.sarvam_errors;


          pageResults.push({

            url: pageUrl,

            success: true,

            ...result

          });


        } catch (error) {

          stats.pages_failed++;


          pageResults.push({

            url: pageUrl,

            success: false,

            error:
              error.message

          });

        }

      }


      // ======================================================
      // PAGINATION
      // ======================================================

      const nextOffset =
        pageOffset +
        pages.length;


      const hasMore =
        nextOffset <
        allPages.length;


      // ======================================================
      // RESPONSE
      // ======================================================

      return jsonResponse({

        success: true,

        application_id:
          applicationId,

        website:
          websiteUrl,

        stats,

        pagination: {

          page_offset:
            pageOffset,

          next_offset:
            hasMore
              ? nextOffset
              : null,

          has_more_pages:
            hasMore,

          total_pages:
            allPages.length

        },

        page_results:
          pageResults,

        message:
          hasMore
            ? `Batch completed. Continue with page_offset=${nextOffset}.`
            : "All discovered pages processed."

      });


    } catch (error) {

      console.error(
        "WORKER_ERROR",
        error
      );


      return jsonResponse(
        {
          success: false,
          error:
            error.message
        },
        500
      );

    }

  }

};


// ============================================================
// PROCESS ONE PAGE
// ============================================================

async function processPage(
  env,
  applicationId,
  pageUrl
) {


  // ==========================================================
  // DOWNLOAD PAGE
  // ==========================================================

  const response =
    await fetchWithTimeout(
      pageUrl,
      {
        method: "GET",

        headers: {

          "User-Agent":
            "ReportliAI-KnowledgeBot/1.0",

          "Accept":
            "text/html,application/xhtml+xml"

        }
      },
      CONFIG.WEBSITE_TIMEOUT
    );


  if (!response.ok) {

    throw new Error(
      `Page returned HTTP ${response.status}`
    );

  }


  // ==========================================================
  // CHECK CONTENT TYPE
  // ==========================================================

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  if (
    !contentType.includes("text/html") &&
    !contentType.includes(
      "application/xhtml+xml"
    )
  ) {

    throw new Error(
      `Not an HTML page: ${contentType}`
    );

  }


  // ==========================================================
  // READ HTML
  // ==========================================================

  const html =
    await readLimitedText(
      response,
      CONFIG.MAX_HTML_BYTES
    );


  // ==========================================================
  // CLEAN HTML
  // ==========================================================

  const page =
    extractReadableContent(
      html
    );


  if (!page.text.trim()) {

    throw new Error(
      "No readable content found."
    );

  }


  // ==========================================================
  // SPLIT PAGE INTO SMALL CHUNKS
  // ==========================================================

  const chunks =
    createChunks(
      page.text,
      CONFIG.CHUNK_SIZE,
      CONFIG.CHUNK_OVERLAP
    );


  // ==========================================================
  // LIMIT SAFETY
  // ==========================================================

  const limitedChunks =
    chunks.slice(
      0,
      CONFIG.MAX_CHUNKS_PER_PAGE
    );


  let chunksSent = 0;

  let fieldsExtracted = 0;

  let fieldsSaved = 0;

  let fieldsFailed = 0;

  let sarvamErrors = 0;


  // ==========================================================
  // PROCESS CHUNKS ONE BY ONE
  // ==========================================================

  for (
    let index = 0;
    index < limitedChunks.length;
    index++
  ) {

    const chunk =
      limitedChunks[index];


    try {

      // ------------------------------------------------------
      // SEND SMALL CHUNK TO SARVAM
      // ------------------------------------------------------

      const extracted =
        await extractChunkWithSarvam(
          env,
          {
            url:
              pageUrl,

            title:
              page.title,

            chunk:
              chunk,

            chunkNumber:
              index + 1,

            totalChunks:
              limitedChunks.length
          }
        );


      chunksSent++;


      // ------------------------------------------------------
      // NORMALIZE FIELDS
      // ------------------------------------------------------

      const fields =
        normalizeFields(
          extracted?.fields
        );


      fieldsExtracted +=
        fields.length;


      // ------------------------------------------------------
      // SAVE EACH FIELD
      // ------------------------------------------------------

      for (
        const item of fields
      ) {

        try {

          await saveBusinessData(
            env,

            applicationId,

            item.field,

            item.data,

            pageUrl
          );


          fieldsSaved++;


        } catch (error) {

          fieldsFailed++;


          console.error(
            "SAVE_FIELD_ERROR",
            {
              pageUrl,
              field:
                item.field,
              error:
                error.message
            }
          );

        }

      }


    } catch (error) {

      sarvamErrors++;


      console.error(
        "SARVAM_CHUNK_ERROR",
        {
          pageUrl,
          chunk:
            index + 1,
          error:
            error.message
        }
      );


      // ------------------------------------------------------
      // IMPORTANT:
      //
      // One bad chunk should NOT stop the entire page.
      // ------------------------------------------------------

      continue;

    }

  }


  return {

    chunks_sent_to_ai:
      chunksSent,

    fields_extracted:
      fieldsExtracted,

    fields_saved:
      fieldsSaved,

    fields_failed:
      fieldsFailed,

    sarvam_errors:
      sarvamErrors

  };

}


// ============================================================
// SARVAM 105B EXTRACTION
// ============================================================

async function extractChunkWithSarvam(
  env,
  input
) {


  // ==========================================================
  // SYSTEM PROMPT
  //
  // SHORT ON PURPOSE.
  //
  // We don't want a giant instruction prompt repeated
  // for every large website page.
  // ==========================================================

  const systemPrompt = `
You extract factual business knowledge from website text.

Extract EVERY useful fact actually present in the text.

Rules:
- Never invent facts.
- Never guess.
- Use meaningful lowercase snake_case field names.
- Do not use section_1, section_2, text_1, unknown, data_1.
- Extract names, services, products, prices, policies, hours, locations, staff, doctors, facilities, contact details, FAQs, qualifications, payment information, appointment information, company history, service areas and other useful business facts.
- Preserve important details.
- If a list exists, return an array.
- If structured information exists, return an object.
- Ignore navigation, cookie notices, tracking text, CSS, JavaScript and generic website boilerplate.
- Only use information contained in the supplied text.
- Return JSON only.
`;


  // ==========================================================
  // USER PROMPT
  // ==========================================================

  const userPrompt = `
URL:
${input.url}

PAGE TITLE:
${input.title || ""}

CHUNK:
${input.chunkNumber}/${input.totalChunks}

CONTENT:
${input.chunk}

Extract the factual business knowledge from this chunk.
`;


  // ==========================================================
  // STRUCTURED OUTPUT
  //
  // Keep schema simple.
  // The previous anyOf-heavy schema can make structured
  // extraction unnecessarily fragile.
  //
  // data is returned as JSON-compatible text.
  // We parse it ourselves before saving to jsonb.
  // ==========================================================

  const responseFormat = {

    type:
      "json_schema",

    json_schema: {

      name:
        "business_knowledge",

      strict:
        true,

      description:
        "Business facts extracted from website content.",

      schema: {

        type:
          "object",

        additionalProperties:
          false,

        properties: {

          fields: {

            type:
              "array",

            items: {

              type:
                "object",

              additionalProperties:
                false,

              properties: {

                field: {
                  type:
                    "string"
                },

                data: {
                  type:
                    "string"
                }

              },

              required: [
                "field",
                "data"
              ]

            }

          }

        },

        required: [
          "fields"
        ]

      }

    }

  };


  // ==========================================================
  // CALL SARVAM
  // ==========================================================

  const response =
    await fetchWithTimeout(
      CONFIG.SARVAM_URL,
      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY

        },

        body:
          JSON.stringify({

            model:
              CONFIG.SARVAM_MODEL,

            messages: [

              {
                role:
                  "system",

                content:
                  systemPrompt
              },

              {
                role:
                  "user",

                content:
                  userPrompt
              }

            ],

            // ------------------------------------------------
            // Structured JSON
            // ------------------------------------------------

            response_format:
              responseFormat,

            // ------------------------------------------------
            // Very low randomness
            // ------------------------------------------------

            temperature:
              0.1,

            // ------------------------------------------------
            // IMPORTANT:
            //
            // Disable reasoning.
            //
            // This is an extraction task, not a reasoning task.
            // ------------------------------------------------

            reasoning_effort:
              null,

            // ------------------------------------------------
            // Give enough room for many extracted facts.
            // ------------------------------------------------

            max_tokens:
              4096

          })

      },

      CONFIG.SARVAM_TIMEOUT
    );


  // ==========================================================
  // READ RESPONSE
  // ==========================================================

  const raw =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `Sarvam HTTP ${response.status}: ${raw.slice(
        0,
        1500
      )}`
    );

  }


  let apiResponse;

  try {

    apiResponse =
      JSON.parse(raw);

  } catch {

    throw new Error(
      "Sarvam returned invalid JSON."
    );

  }


  // ==========================================================
  // GET MODEL CONTENT
  // ==========================================================

  const content =
    apiResponse
      ?.choices?.[0]
      ?.message
      ?.content;


  if (!content) {

    throw new Error(
      "Sarvam returned empty content."
    );

  }


  // ==========================================================
  // PARSE MODEL JSON
  // ==========================================================

  let result;

  try {

    result =
      typeof content === "string"
        ? JSON.parse(content)
        : content;

  } catch {

    throw new Error(
      "Sarvam output could not be parsed as JSON."
    );

  }


  return result;

}


// ============================================================
// NORMALIZE FIELDS
// ============================================================

function normalizeFields(
  fields
) {

  if (
    !Array.isArray(fields)
  ) {

    return [];

  }


  const results = [];


  for (
    const item of fields
  ) {

    if (!item) {
      continue;
    }


    // --------------------------------------------------------
    // FIELD NAME
    // --------------------------------------------------------

    let field =
      String(
        item.field || ""
      )
        .trim()
        .toLowerCase();


    if (!field) {
      continue;
    }


    field =
      field
        .replace(
          /[\s-]+/g,
          "_"
        )
        .replace(
          /[^a-z0-9_]/g,
          ""
        )
        .replace(
          /_+/g,
          "_"
        )
        .replace(
          /^_+|_+$/g,
          ""
        );


    if (!field) {
      continue;
    }


    // --------------------------------------------------------
    // Reject useless names
    // --------------------------------------------------------

    const forbidden =
      new Set([

        "section",
        "section_1",
        "section_2",

        "text",
        "text_1",
        "text_2",

        "data",
        "data_1",
        "data_2",

        "unknown",
        "information",

        "content"

      ]);


    if (
      forbidden.has(field)
    ) {

      continue;

    }


    // --------------------------------------------------------
    // DATA
    // --------------------------------------------------------

    let data =
      item.data;


    if (
      typeof data !==
      "string"
    ) {

      data =
        JSON.stringify(
          data
        );

    }


    data =
      data.trim();


    if (!data) {
      continue;
    }


    // --------------------------------------------------------
    // Convert AI's JSON string back into JSONB
    //
    // Example:
    //
    // "[\"Dental implants\",\"Root canal\"]"
    //
    // becomes a real JSON array.
    // --------------------------------------------------------

    let parsedData;


    try {

      parsedData =
        JSON.parse(
          data
        );

    } catch {

      // Normal text
      parsedData =
        data;

    }


    results.push({

      field,

      data:
        parsedData

    });

  }


  return results;

}


// ============================================================
// SAVE TO SUPABASE
// ============================================================

async function saveBusinessData(
  env,
  applicationId,
  field,
  data,
  sourceUrl
) {


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
          JSON.stringify({

            application_id:
              applicationId,

            field,

            data,

            source_url:
              sourceUrl,

            updated_at:
              new Date().toISOString()

          })

      }
    );


  if (!response.ok) {

    const error =
      await response.text();


    throw new Error(
      `Supabase error ${response.status}: ${error}`
    );

  }

}


// ============================================================
// VERIFY APPLICATION
// ============================================================

async function getApplication(
  env,
  applicationId
) {


  const endpoint =
    `${env.SUPABASE_URL}/rest/v1/applications` +
    `?id=eq.${encodeURIComponent(
      applicationId
    )}` +
    `&select=id,user_id,name` +
    `&limit=1`;


  const response =
    await fetch(
      endpoint,
      {

        headers: {

          "apikey":
            env.SUPABASE_SECRET_KEY,

          "Authorization":
            `Bearer ${env.SUPABASE_SECRET_KEY}`

        }

      }
    );


  if (!response.ok) {

    throw new Error(
      `Application lookup failed: ${response.status}`
    );

  }


  const rows =
    await response.json();


  return rows?.[0] || null;

}


// ============================================================
// PAGE DISCOVERY
// ============================================================

async function discoverPages(
  websiteUrl
) {


  const origin =
    new URL(
      websiteUrl
    ).origin;


  const hostname =
    new URL(
      websiteUrl
    ).hostname;


  const urls =
    new Set();


  // ----------------------------------------------------------
  // Homepage
  // ----------------------------------------------------------

  urls.add(
    normalizeUrl(
      websiteUrl
    )
  );


  // ----------------------------------------------------------
  // Sitemap candidates
  // ----------------------------------------------------------

  const sitemapQueue =
    new Set([

      `${origin}/sitemap.xml`,

      `${origin}/sitemap_index.xml`

    ]);


  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  try {

    const robots =
      await fetchWithTimeout(
        `${origin}/robots.txt`,
        {
          headers: {
            "User-Agent":
              "ReportliAI-KnowledgeBot/1.0"
          }
        },
        CONFIG.WEBSITE_TIMEOUT
      );


    if (robots.ok) {

      const text =
        await robots.text();


      const matches =
        text.match(
          /Sitemap:\s*(.+)/gi
        );


      if (matches) {

        for (
          const line of matches
        ) {

          const sitemap =
            line
              .replace(
                /Sitemap:\s*/i,
                ""
              )
              .trim();


          if (
            isSafeUrl(
              sitemap
            )
          ) {

            sitemapQueue.add(
              sitemap
            );

          }

        }

      }

    }

  } catch {

    // robots is optional

  }


  // ----------------------------------------------------------
  // Process sitemaps
  // ----------------------------------------------------------

  const processed =
    new Set();


  while (

    sitemapQueue.size > 0 &&

    processed.size <
      CONFIG.MAX_SITEMAPS

  ) {


    const sitemapUrl =
      sitemapQueue.values()
        .next()
        .value;


    sitemapQueue.delete(
      sitemapUrl
    );


    if (
      processed.has(
        sitemapUrl
      )
    ) {

      continue;

    }


    processed.add(
      sitemapUrl
    );


    try {

      const response =
        await fetchWithTimeout(
          sitemapUrl,
          {
            headers: {
              "User-Agent":
                "ReportliAI-KnowledgeBot/1.0"
            }
          },
          CONFIG.WEBSITE_TIMEOUT
        );


      if (!response.ok) {
        continue;
      }


      const xml =
        await readLimitedText(
          response,
          2_000_000
        );


      // ------------------------------------------------------
      // Sitemap indexes
      // ------------------------------------------------------

      const childSitemaps =
        extractXmlLocs(
          xml,
          "sitemap"
        );


      for (
        const child of childSitemaps
      ) {

        if (
          processed.size +
            sitemapQueue.size <
          CONFIG.MAX_SITEMAPS
        ) {

          sitemapQueue.add(
            child
          );

        }

      }


      // ------------------------------------------------------
      // Page URLs
      // ------------------------------------------------------

      const pageUrls =
        extractXmlLocs(
          xml,
          "url"
        );


      for (
        const pageUrl of pageUrls
      ) {

        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {

          break;

        }


        try {

          const parsed =
            new URL(
              pageUrl
            );


          if (
            parsed.hostname ===
            hostname
          ) {

            urls.add(
              normalizeUrl(
                pageUrl
              )
            );

          }

        } catch {

          // ignore

        }

      }

    } catch {

      // ignore broken sitemap

    }

  }


  // ----------------------------------------------------------
  // Also crawl homepage links
  // ----------------------------------------------------------

  try {

    const response =
      await fetchWithTimeout(
        websiteUrl,
        {
          headers: {
            "User-Agent":
              "ReportliAI-KnowledgeBot/1.0"
          }
        },
        CONFIG.WEBSITE_TIMEOUT
      );


    if (response.ok) {

      const html =
        await readLimitedText(
          response,
          CONFIG.MAX_HTML_BYTES
        );


      const links =
        extractInternalLinks(
          html,
          origin,
          hostname
        );


      for (
        const link of links
      ) {

        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {

          break;

        }


        urls.add(
          link
        );

      }

    }

  } catch {

    // ignore

  }


  return {

    urls:
      [...urls]

  };

}


// ============================================================
// EXTRACT XML LOCATIONS
// ============================================================

function extractXmlLocs(
  xml,
  type
) {


  const results = [];


  const regex =
    new RegExp(
      `<${type}[^>]*>[\\s\\S]*?<loc[^>]*>([\\s\\S]*?)<\\/loc>[\\s\\S]*?<\\/${type}>`,
      "gi"
    );


  let match;


  while (
    (match =
      regex.exec(xml))
  ) {

    const value =
      decodeHtmlEntities(
        match[1]
          .trim()
      );


    if (
      isSafeUrl(
        value
      )
    ) {

      results.push(
        value
      );

    }

  }


  return results;

}


// ============================================================
// EXTRACT INTERNAL LINKS
// ============================================================

function extractInternalLinks(
  html,
  origin,
  hostname
) {


  const links =
    new Set();


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;


  let match;


  while (
    (match =
      regex.exec(html))
  ) {


    let raw =
      decodeHtmlEntities(
        match[1]
      )
        .trim();


    if (
      !raw ||
      raw.startsWith("#") ||
      raw.startsWith(
        "mailto:"
      ) ||
      raw.startsWith(
        "tel:"
      ) ||
      raw.startsWith(
        "javascript:"
      )
    ) {

      continue;

    }


    try {

      const url =
        new URL(
          raw,
          origin
        );


      if (
        url.hostname !==
        hostname
      ) {

        continue;

      }


      url.hash = "";


      links.add(
        normalizeUrl(
          url.toString()
        )
      );


    } catch {

      // ignore

    }

  }


  return [
    ...links
  ];

}


// ============================================================
// CLEAN HTML
// ============================================================

function extractReadableContent(
  html
) {


  // ----------------------------------------------------------
  // Title
  // ----------------------------------------------------------

  const titleMatch =
    html.match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i
    );


  const title =
    titleMatch
      ? cleanText(
          titleMatch[1]
        )
      : "";


  // ----------------------------------------------------------
  // Remove things AI doesn't need
  // ----------------------------------------------------------

  let content =
    html

      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )

      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )

      .replace(
        /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
        " "
      )

      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        " "
      )

      .replace(
        /<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi,
        " "
      )

      .replace(
        /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
        " "
      )

      .replace(
        /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
        " "
      )

      .replace(
        /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
        " "
      )

      .replace(
        /<aside\b[^>]*>[\s\S]*?<\/aside>/gi,
        " "
      );


  // ----------------------------------------------------------
  // Preserve block boundaries
  // ----------------------------------------------------------

  content =
    content.replace(
      /<\/(p|div|section|article|main|li|h1|h2|h3|h4|h5|h6|tr|br)>/gi,
      "\n"
    );


  // ----------------------------------------------------------
  // Remove tags
  // ----------------------------------------------------------

  content =
    content.replace(
      /<[^>]+>/g,
      " "
    );


  // ----------------------------------------------------------
  // Decode entities
  // ----------------------------------------------------------

  content =
    decodeHtmlEntities(
      content
    );


  // ----------------------------------------------------------
  // Normalize
  // ----------------------------------------------------------

  content =
    content
      .replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /[ \t]+/g,
        " "
      )
      .replace(
        /\n\s*\n+/g,
        "\n\n"
      )
      .trim();


  // ----------------------------------------------------------
  // Remove blank lines
  // ----------------------------------------------------------

  content =
    content
      .split("\n")
      .map(
        line =>
          line.trim()
      )
      .filter(
        Boolean
      )
      .join("\n");


  return {

    title,

    text:
      content

  };

}


// ============================================================
// SMART CHUNKING
//
// This is one of the biggest changes.
//
// Instead of 30,000 characters,
// use ~6,000-character chunks.
//
// We also overlap 500 characters so a fact that
// crosses a boundary is less likely to be lost.
// ============================================================

function createChunks(
  text,
  chunkSize,
  overlap
) {


  const chunks = [];


  if (
    text.length <=
    chunkSize
  ) {

    return [
      text
    ];

  }


  let start = 0;


  while (
    start < text.length
  ) {


    let end =
      Math.min(
        start +
          chunkSize,
        text.length
      );


    // --------------------------------------------------------
    // Prefer ending at paragraph boundary
    // --------------------------------------------------------

    if (
      end <
      text.length
    ) {

      const paragraphBreak =
        text.lastIndexOf(
          "\n\n",
          end
        );


      if (
        paragraphBreak >
        start +
          Math.floor(
            chunkSize *
              0.6
          )
      ) {

        end =
          paragraphBreak;

      }

    }


    const chunk =
      text
        .slice(
          start,
          end
        )
        .trim();


    if (chunk) {

      chunks.push(
        chunk
      );

    }


    if (
      end >=
      text.length
    ) {

      break;

    }


    // --------------------------------------------------------
    // Overlap
    // --------------------------------------------------------

    start =
      Math.max(
        end -
          overlap,
        start + 1
      );

  }


  return chunks;

}


// ============================================================
// READ RESPONSE WITH SIZE LIMIT
// ============================================================

async function readLimitedText(
  response,
  maxBytes
) {


  if (!response.body) {

    const text =
      await response.text();


    if (
      new TextEncoder()
        .encode(text)
        .length >
      maxBytes
    ) {

      throw new Error(
        "Response too large."
      );

    }


    return text;

  }


  const reader =
    response.body.getReader();


  const decoder =
    new TextDecoder();


  let result =
    "";

  let total =
    0;


  while (true) {

    const {
      done,
      value
    } =
      await reader.read();


    if (done) {
      break;
    }


    total +=
      value.byteLength;


    if (
      total >
      maxBytes
    ) {

      try {
        await reader.cancel();
      } catch {}


      throw new Error(
        "Response exceeded size limit."
      );

    }


    result +=
      decoder.decode(
        value,
        {
          stream:
            true
        }
      );

  }


  result +=
    decoder.decode();


  return result;

}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs
) {


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );


  try {

    return await fetch(
      url,
      {
        ...options,

        signal:
          controller.signal
      }
    );

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      throw new Error(
        `Request timed out: ${url}`
      );

    }


    throw error;

  } finally {

    clearTimeout(
      timer
    );

  }

}


// ============================================================
// URL NORMALIZATION
// ============================================================

function normalizeWebsiteUrl(
  input
) {


  let value =
    String(
      input
    ).trim();


  if (
    !/^https?:\/\//i.test(
      value
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


  url.hash =
    "";


  return normalizeUrl(
    url.toString()
  );

}


// ============================================================
// NORMALIZE URL
// ============================================================

function normalizeUrl(
  input
) {


  const url =
    new URL(
      input
    );


  url.hash =
    "";


  const removeParams = [

    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid"

  ];


  for (
    const key of [
      ...url.searchParams.keys()
    ]
  ) {

    if (
      key.startsWith(
        "utm_"
      ) ||
      removeParams.includes(
        key
      )
    ) {

      url.searchParams.delete(
        key
      );

    }

  }


  let result =
    url.toString();


  if (
    url.pathname !== "/" &&
    result.endsWith("/")
  ) {

    result =
      result.slice(
        0,
        -1
      );

  }


  return result;

}


// ============================================================
// SAFE URL
// ============================================================

function isSafeUrl(
  input
) {

  try {

    const url =
      new URL(
        input
      );


    return (
      url.protocol ===
        "http:" ||
      url.protocol ===
        "https:"
    );

  } catch {

    return false;

  }

}


// ============================================================
// CLEAN TEXT
// ============================================================

function cleanText(
  value
) {

  return decodeHtmlEntities(
    String(
      value
    )
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );

}


// ============================================================
// HTML ENTITY DECODER
// ============================================================

function decodeHtmlEntities(
  value
) {

  return String(
    value
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
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
    )

    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(
          Number(
            code
          )
        )
    )

    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(
            code,
            16
          )
        )
    );

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

        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders()

      }

    }

  );

}


// ============================================================
// CORS
// ============================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"

  };

        }
