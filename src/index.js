// ============================================================
// Reportli AI Website Scraper
// VERSION: 2026-09-25-V2
// ============================================================

const VERSION = "2026-09-25-V2";

const PAGES_PER_BATCH = 3;
const MAX_AI_CALLS = 6;
const MAX_CHUNKS_PER_PAGE = 2;
const CHUNK_SIZE = 7000;
const CHUNK_OVERLAP = 500;
const FETCH_TIMEOUT = 15000;


// ============================================================
// WORKER
// ============================================================

export default {
  async fetch(request, env) {

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "POST required",
        worker_version: VERSION
      }, 405);
    }

    try {

      const body = await request.json();

      const applicationId =
        String(body.application_id || "").trim();

      const domain =
        String(body.domain || "").trim();

      const pageOffset =
        Math.max(
          0,
          Number(body.page_offset || 0)
        );

      if (!applicationId) {
        return json({
          success: false,
          error: "application_id required",
          worker_version: VERSION
        }, 400);
      }

      if (!domain) {
        return json({
          success: false,
          error: "domain required",
          worker_version: VERSION
        }, 400);
      }


      // --------------------------------------------------------
      // IMPORTANT:
      // Only actual HTML pages are allowed here.
      // --------------------------------------------------------

      const website =
        normalizeUrl(domain);


      // --------------------------------------------------------
      // Discover URLs
      // --------------------------------------------------------

      const discovered =
        await discoverUrls(website);


      // --------------------------------------------------------
      // Remove XML and other files
      // --------------------------------------------------------

      const pageUrls =
        Array.from(
          new Set(
            discovered
              .map(normalizeUrl)
              .filter(isHtmlPage)
          )
        );


      // --------------------------------------------------------
      // Select batch
      // --------------------------------------------------------

      const selected =
        pageUrls.slice(
          pageOffset,
          pageOffset + PAGES_PER_BATCH
        );


      const stats = {

        pages_discovered:
          pageUrls.length,

        pages_selected:
          selected.length,

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


      // ========================================================
      // PROCESS PAGES
      // ========================================================

      for (const pageUrl of selected) {

        try {

          // ----------------------------------------------------
          // Fetch HTML
          // ----------------------------------------------------

          const html =
            await fetchHtml(pageUrl);


          // ----------------------------------------------------
          // Extract text
          // ----------------------------------------------------

          const page =
            extractText(html);


          if (!page.text) {
            throw new Error(
              "No readable text found"
            );
          }


          // ----------------------------------------------------
          // Split page
          // ----------------------------------------------------

          const chunks =
            splitText(
              page.text,
              CHUNK_SIZE,
              CHUNK_OVERLAP
            ).slice(
              0,
              MAX_CHUNKS_PER_PAGE
            );


          const fieldMap =
            new Map();


          // ----------------------------------------------------
          // AI
          // ----------------------------------------------------

          for (const chunk of chunks) {

            if (
              stats.chunks_sent_to_ai >=
              MAX_AI_CALLS
            ) {
              break;
            }


            const result =
              await askSarvam(
                env,
                chunk
              );


            stats.chunks_sent_to_ai++;


            if (result.error) {

              stats.sarvam_errors++;

              continue;
            }


            for (
              const item of result.fields
            ) {

              const field =
                cleanField(
                  item.field
                );

              const data =
                cleanData(
                  item.data
                );


              // NEVER save empty data.
              if (!field) continue;

              if (!useful(data)) continue;


              if (
                fieldMap.has(field)
              ) {

                fieldMap.set(
                  field,
                  merge(
                    fieldMap.get(field),
                    data
                  )
                );

              } else {

                fieldMap.set(
                  field,
                  data
                );
              }
            }
          }


          // ----------------------------------------------------
          // Prepare rows
          // ----------------------------------------------------

          const rows = [];


          for (
            const [field, data]
            of fieldMap
          ) {

            if (!useful(data)) {
              continue;
            }


            rows.push({

              application_id:
                applicationId,

              field,

              data,

              source_url:
                pageUrl
            });
          }


          stats.fields_extracted +=
            rows.length;


          // ----------------------------------------------------
          // ONE Supabase request
          // ----------------------------------------------------

          if (rows.length > 0) {

            const saved =
              await saveRows(
                env,
                rows
              );


            if (!saved.success) {

              stats.fields_failed +=
                rows.length;

              throw new Error(
                saved.error
              );
            }


            stats.fields_saved +=
              rows.length;
          }


          stats.pages_processed++;


          pageResults.push({

            url: pageUrl,

            success: true,

            fields_extracted:
              rows.length,

            fields_saved:
              rows.length
          });


        } catch (error) {

          stats.pages_failed++;


          pageResults.push({

            url: pageUrl,

            success: false,

            error:
              error?.message ||
              String(error)
          });
        }
      }


      // ========================================================
      // PAGINATION
      // ========================================================

      const nextOffset =
        pageOffset +
        selected.length;

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
// DISCOVER URLS
// ============================================================

async function discoverUrls(
  website
) {

  const origin =
    new URL(website).origin;


  const urls =
    new Set();


  // Always include homepage.
  urls.add(
    normalizeUrl(website)
  );


  // ----------------------------------------------------------
  // Sitemap
  // ----------------------------------------------------------

  const sitemapUrls = [

    `${origin}/sitemap.xml`,

    `${origin}/wp-sitemap.xml`,

    `${origin}/sitemap_index.xml`

  ];


  for (
    const sitemap
    of sitemapUrls
  ) {

    try {

      const response =
        await fetch(
          sitemap,
          {
            headers: {
              "User-Agent":
                "ReportliAI/1.0"
            }
          }
        );


      if (!response.ok) {
        continue;
      }


      const text =
        await response.text();


      const locations =
        extractLocs(text);


      for (
        const url
        of locations
      ) {

        // NEVER add XML files.
        if (
          url
            .toLowerCase()
            .endsWith(".xml")
        ) {
          continue;
        }


        if (
          isHtmlPage(url)
        ) {

          urls.add(
            normalizeUrl(url)
          );
        }


        if (
          urls.size >= 127
        ) {
          break;
        }
      }


      // If we found real pages,
      // stop checking other sitemap files.
      if (
        urls.size > 1
      ) {
        break;
      }

    } catch {
      // Ignore sitemap failure.
    }
  }


  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  if (
    urls.size <= 1
  ) {

    try {

      const response =
        await fetch(
          `${origin}/robots.txt`
        );


      if (response.ok) {

        const robots =
          await response.text();


        const matches =
          robots.match(
            /^sitemap\s*:\s*(.+)$/gim
          ) || [];


        for (
          const line
          of matches
        ) {

          const sitemap =
            line
              .replace(
                /^sitemap\s*:\s*/i,
                ""
              )
              .trim();


          try {

            const response2 =
              await fetch(
                sitemap
              );


            if (!response2.ok) {
              continue;
            }


            const xml =
              await response2.text();


            const locations =
              extractLocs(xml);


            for (
              const url
              of locations
            ) {

              if (
                isHtmlPage(url)
              ) {

                urls.add(
                  normalizeUrl(url)
                );
              }
            }

          } catch {
            // Ignore.
          }
        }
      }

    } catch {
      // Ignore.
    }
  }


  return Array.from(urls);
}


// ============================================================
// EXTRACT <LOC>
// ============================================================

function extractLocs(
  xml
) {

  const output = [];


  const regex =
    /<loc[^>]*>([\s\S]*?)<\/loc>/gi;


  let match;


  while (
    (match = regex.exec(xml))
  ) {

    const url =
      decodeEntities(
        match[1]
      )
        .trim();


    if (url) {
      output.push(url);
    }
  }


  return output;
}


// ============================================================
// CHECK HTML PAGE
// ============================================================

function isHtmlPage(
  value
) {

  try {

    const url =
      new URL(value);


    const path =
      url.pathname
        .toLowerCase();


    const blocked = [

      ".xml",
      ".json",
      ".txt",
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
      ".mp3",
      ".mp4",
      ".mov",
      ".avi",
      ".css",
      ".js",
      ".woff",
      ".woff2",
      ".ttf"
    ];


    for (
      const extension
      of blocked
    ) {

      if (
        path.endsWith(extension)
      ) {
        return false;
      }
    }


    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );

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

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT
    );


  try {

    const response =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "ReportliAI/1.0",
            "Accept":
              "text/html,application/xhtml+xml"
          },

          signal:
            controller.signal
        }
      );


    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );
    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    if (
      !contentType.includes("text/html") &&
      !contentType.includes("xhtml")
    ) {

      throw new Error(
        `Not HTML: ${contentType}`
      );
    }


    return await response.text();

  } finally {

    clearTimeout(timer);
  }
}


// ============================================================
// EXTRACT PAGE TEXT
// ============================================================

function extractText(
  html
) {

  let value =
    String(html || "");


  // Remove useless sections.
  value =
    value.replace(
      /<(script|style|noscript|svg|canvas|iframe|nav|footer|aside|header)[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    );


  // Get title.
  const titleMatch =
    value.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );


  const title =
    titleMatch
      ? cleanText(
          decodeEntities(
            titleMatch[1]
          )
        )
      : "";


  // Remove HTML.
  value =
    value.replace(
      /<[^>]+>/g,
      " "
    );


  // Decode.
  value =
    decodeEntities(value);


  // IMPORTANT:
  // This function is defined here.
  // No "cleanText is not defined" error.
  const text =
    cleanText(value);


  return {
    title,
    text
  };
}


// ============================================================
// CLEAN TEXT
// ============================================================

function cleanText(
  value
) {

  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}


// ============================================================
// DECODE HTML
// ============================================================

function decodeEntities(
  value
) {

  return String(value || "")

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
    );
}


// ============================================================
// SPLIT TEXT
// ============================================================

function splitText(
  text,
  size,
  overlap
) {

  const value =
    cleanText(text);


  if (!value) {
    return [];
  }


  if (
    value.length <= size
  ) {
    return [value];
  }


  const chunks = [];

  let start = 0;


  while (
    start < value.length &&
    chunks.length < 50
  ) {

    const end =
      Math.min(
        start + size,
        value.length
      );


    chunks.push(
      value.slice(
        start,
        end
      )
    );


    if (
      end >= value.length
    ) {
      break;
    }


    start =
      end - overlap;
  }


  return chunks;
}


// ============================================================
// SARVAM
// ============================================================

async function askSarvam(
  env,
  chunk
) {

  const prompt = `
Extract factual business information from this page.

Use specific field names.
Single value = string.
Multiple values = array.
Never guess.
Never return empty strings, null, or [].
Skip missing information.

Return:
{"fields":[{"field":"name","data":"value"}]}

PAGE:
${chunk}
`;


  try {

    const response =
      await fetch(
        "https://api.sarvam.ai/v1/chat/completions",
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "api-subscription-key":
              env.SARVAM_API_KEY
          },

          body:
            JSON.stringify({

              model:
                "sarvam-105b",

              messages: [

                {
                  role: "system",

                  content:
                    "Return valid JSON only. Extract facts only."
                },

                {
                  role: "user",

                  content:
                    prompt
                }

              ],

              temperature:
                0.1,

              max_tokens:
                4096,

              reasoning_effort:
                null,

              response_format: {
                type: "json_object"
              }
            })
        }
      );


    if (!response.ok) {

      const error =
        await response.text();


      return {
        error:
          `Sarvam ${response.status}: ${error}`,
        fields: []
      };
    }


    const result =
      await response.json();


    const content =
      result
        ?.choices?.[0]
        ?.message
        ?.content;


    if (!content) {

      return {
        error:
          "Empty Sarvam response",
        fields: []
      };
    }


    let parsed;


    try {

      parsed =
        typeof content === "string"
          ? JSON.parse(
              content
            )
          : content;

    } catch {

      return {
        error:
          "Invalid Sarvam JSON",
        fields: []
      };
    }


    const fields =
      Array.isArray(
        parsed.fields
      )
        ? parsed.fields
        : [];


    return {
      fields
    };


  } catch (error) {

    return {
      error:
        error?.message ||
        String(error),

      fields: []
    };
  }
}


// ============================================================
// FIELD CLEANING
// ============================================================

function cleanField(
  value
) {

  return String(value || "")
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
      100
    );
}


// ============================================================
// DATA CLEANING
// ============================================================

function cleanData(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }


  if (
    typeof value === "string"
  ) {

    const result =
      cleanText(value);


    return result
      ? result
      : null;
  }


  if (
    Array.isArray(value)
  ) {

    const result =
      value.filter(
        item =>
          item !== null &&
          item !== undefined &&
          item !== ""
      );


    return result.length
      ? result
      : null;
  }


  if (
    typeof value === "object"
  ) {

    return Object.keys(value).length
      ? value
      : null;
  }


  return value;
}


// ============================================================
// USEFUL DATA CHECK
// ============================================================

function useful(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {
    return false;
  }


  if (
    typeof value === "string"
  ) {

    return (
      value.trim().length > 0
    );
  }


  if (
    Array.isArray(value)
  ) {

    return value.length > 0;
  }


  if (
    typeof value === "object"
  ) {

    return (
      Object.keys(value).length > 0
    );
  }


  return true;
}


// ============================================================
// MERGE DATA
// ============================================================

function merge(
  oldValue,
  newValue
) {

  if (
    !useful(oldValue)
  ) {
    return newValue;
  }


  if (
    !useful(newValue)
  ) {
    return oldValue;
  }


  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return unique([
      ...oldValue,
      ...newValue
    ]);
  }


  if (
    Array.isArray(oldValue)
  ) {

    return unique([
      ...oldValue,
      newValue
    ]);
  }


  if (
    Array.isArray(newValue)
  ) {

    return unique([
      oldValue,
      ...newValue
    ]);
  }


  if (
    typeof oldValue === "object" &&
    typeof newValue === "object"
  ) {

    return {
      ...oldValue,
      ...newValue
    };
  }


  if (
    String(oldValue) !==
    String(newValue)
  ) {

    return unique([
      oldValue,
      newValue
    ]);
  }


  return oldValue;
}


// ============================================================
// UNIQUE
// ============================================================

function unique(
  values
) {

  const result = [];
  const seen = new Set();


  for (
    const value
    of values
  ) {

    const key =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value);


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(key);
    result.push(value);
  }


  return result;
}


// ============================================================
// SUPABASE SAVE
// ============================================================

async function saveRows(
  env,
  rows
) {

  try {

    const url =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      "?on_conflict=application_id,source_url,field";


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
            JSON.stringify(rows)
        }
      );


    if (!response.ok) {

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
          "application/json; charset=utf-8"
      }
    }
  );
              }
