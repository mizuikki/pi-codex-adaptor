// Generated from the pinned official Codex tool builders. Do not edit.
export const OFFICIAL_CORE_TOOL_CONTRACTS = {
  "update_plan": {
    "description": "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
    "name": "update_plan",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "explanation": {
          "description": "Optional explanation for this plan update.",
          "type": "string"
        },
        "plan": {
          "description": "The list of steps",
          "items": {
            "additionalProperties": false,
            "properties": {
              "status": {
                "description": "Step status.",
                "enum": [
                  "pending",
                  "in_progress",
                  "completed"
                ],
                "type": "string"
              },
              "step": {
                "description": "Task step text.",
                "type": "string"
              }
            },
            "required": [
              "step",
              "status"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "plan"
      ],
      "type": "object"
    },
    "strict": false,
    "type": "function"
  },
  "exec_command": {
    "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    "name": "exec_command",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "cmd": {
          "description": "Shell command to execute.",
          "type": "string"
        },
        "justification": {
          "description": "User-facing approval question for `require_escalated`; omit otherwise.",
          "type": "string"
        },
        "login": {
          "description": "True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
          "type": "boolean"
        },
        "max_output_tokens": {
          "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
          "type": "number"
        },
        "prefix_rule": {
          "description": "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"].",
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "sandbox_permissions": {
          "description": "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
          "enum": [
            "use_default",
            "require_escalated"
          ],
          "type": "string"
        },
        "shell": {
          "description": "Shell binary to launch. Defaults to the user's default shell.",
          "type": "string"
        },
        "tty": {
          "description": "True allocates a PTY for the command; false or omitted uses plain pipes.",
          "type": "boolean"
        },
        "workdir": {
          "description": "Working directory for the command. Defaults to the turn cwd.",
          "type": "string"
        },
        "yield_time_ms": {
          "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
          "type": "number"
        }
      },
      "required": [
        "cmd"
      ],
      "type": "object"
    },
    "strict": false,
    "type": "function"
  },
  "write_stdin": {
    "description": "Writes characters to an existing unified exec session and returns recent output.",
    "name": "write_stdin",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "chars": {
          "description": "Bytes to write to stdin. Defaults to empty, which polls without writing.",
          "type": "string"
        },
        "max_output_tokens": {
          "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
          "type": "number"
        },
        "session_id": {
          "description": "Identifier of the running unified exec session.",
          "type": "number"
        },
        "yield_time_ms": {
          "description": "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
          "type": "number"
        }
      },
      "required": [
        "session_id"
      ],
      "type": "object"
    },
    "strict": false,
    "type": "function"
  },
  "apply_patch": {
    "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    "format": {
      "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\n\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\n\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF -> line\n\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n\n%import common.LF\n",
      "syntax": "lark",
      "type": "grammar"
    },
    "name": "apply_patch",
    "type": "custom"
  },
  "view_image": {
    "description": "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
    "name": "view_image",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "detail": {
          "description": "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
          "enum": [
            "high",
            "original"
          ],
          "type": "string"
        },
        "path": {
          "description": "Local filesystem path to an image file.",
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "type": "object"
    },
    "strict": false,
    "type": "function"
  },
  "image_gen": {
    "description": "Tools in the image_gen namespace.",
    "name": "image_gen",
    "tools": [
      {
        "description": "The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:\n\n- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.\n- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).\n\nGuidelines:\n- In code mode, pass the result to `generatedImage(result)`.\n- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.\n- For edits, use `referenced_image_paths` when every target image has a local file path.\n- If you have not seen a local image yet, use `view_image` to inspect it before editing.\n- Use `num_last_images_to_include` only when at least one target image has no local file path.\n- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.\n- Never provide both `referenced_image_paths` and `num_last_images_to_include`.\n- If neither mechanism can include every target image, ask the user to attach the missing images again.\n- Directly generate the image without reconfirmation or clarification unless required images must be attached again.\n- After each image generation, do not mention anything related to download. Do not summarize the image. Do not ask followup question. Do not say ANYTHING after you generate an image.\n- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use the `python` tool for image editing unless specifically instructed.\n",
        "name": "imagegen",
        "parameters": {
          "additionalProperties": false,
          "properties": {
            "num_last_images_to_include": {
              "type": [
                "integer",
                "null"
              ]
            },
            "prompt": {
              "type": "string"
            },
            "referenced_image_paths": {
              "items": {
                "type": "string"
              },
              "type": [
                "array",
                "null"
              ]
            }
          },
          "required": [
            "prompt"
          ],
          "type": "object"
        },
        "strict": false,
        "type": "function"
      }
    ],
    "type": "namespace"
  },
  "shell_command": {
    "description": "Runs a shell command and returns its output.\n- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary.",
    "name": "shell_command",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "command": {
          "description": "Shell script to run in the user's default shell.",
          "type": "string"
        },
        "justification": {
          "description": "User-facing approval question for `require_escalated`; omit otherwise.",
          "type": "string"
        },
        "login": {
          "description": "True runs with login shell semantics; false disables them. Defaults to true.",
          "type": "boolean"
        },
        "prefix_rule": {
          "description": "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"].",
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "sandbox_permissions": {
          "description": "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
          "enum": [
            "use_default",
            "require_escalated"
          ],
          "type": "string"
        },
        "timeout_ms": {
          "description": "Maximum command runtime. Defaults to 10000 ms.",
          "type": "number"
        },
        "workdir": {
          "description": "Working directory for the command. Defaults to the turn cwd.",
          "type": "string"
        }
      },
      "required": [
        "command"
      ],
      "type": "object"
    },
    "strict": false,
    "type": "function"
  },
  "web": {
    "description": "Tools in the web namespace.",
    "name": "web",
    "tools": [
      {
        "description": "Tool for accessing the internet.\n\n\n---\n\n## Examples of different commands available in this tool\n\nExamples of different commands available in this tool:\n* `search_query`: {\"search_query\": [{\"q\": \"What is the capital of France?\"}, {\"q\": \"What is the capital of belgium?\"}]}. Searches the internet for a given query (and optionally with a domain or recency filter)\n* `image_query`: {\"image_query\":[{\"q\": \"waterfalls\"}]}.\n* `open`: {\"open\": [{\"ref_id\": \"turn0search0\"}, {\"ref_id\": \"https://www.openai.com\", \"lineno\": 120}]}\n* `click`: {\"click\": [{\"ref_id\": \"turn0fetch3\", \"id\": 17}]}\n* `find`: {\"find\": [{\"ref_id\": \"turn0fetch3\", \"pattern\": \"Annie Case\"}]}\n* `screenshot`: {\"screenshot\": [{\"ref_id\": \"turn1view0\", \"pageno\": 0}, {\"ref_id\": \"turn1view0\", \"pageno\": 3}]}\n* `finance`: {\"finance\":[{\"ticker\":\"AMD\",\"type\":\"equity\",\"market\":\"USA\"}]}, {\"finance\":[{\"ticker\":\"BTC\",\"type\":\"crypto\",\"market\":\"\"}]}\n* `weather`: {\"weather\":[{\"location\":\"San Francisco, CA\"}]}\n* `sports`: {\"sports\":[{\"fn\":\"standings\",\"league\":\"nfl\"}, {\"fn\":\"schedule\",\"league\":\"nba\",\"team\":\"GSW\",\"date_from\":\"2025-02-24\"}]}\n* `time`: {\"time\":[{\"utc_offset\":\"+03:00\"}]}\n\n---\n\n## Usage hints\nTo use this tool efficiently:\n* Use multiple commands and queries in one call to get more results faster; e.g. {\"search_query\": [{\"q\": \"bitcoin news\"}], \"finance\":[{\"ticker\":\"BTC\",\"type\":\"crypto\",\"market\":\"\"}], \"find\": [{\"ref_id\": \"turn0search0\", \"pattern\": \"Annie Case\"}, {\"ref_id\": \"turn0search1\", \"pattern\": \"John Smith\"}]}\n* Use \"response_length\" to control the number of results returned by this tool, omit it if you intend to pass \"short\" in\n* Only write required parameters; do not write empty lists or nulls where they could be omitted.\n* `search_query` must have length at most 4 in each call. If it has length > 3, response_length must be medium or long\n* If you find yourself in a situation where you accidentally call the `web.run` tool, it's best just to send an empty query: {\"search_query\": [{\"q\": \"\"}]}.\n\n---\n\n## Decision boundary\n\nIf the user makes an explicit request to search the internet, find latest information, look up, etc (or to not do so), you must obey their request.\nWhen you make an assumption, always consider whether it is temporally stable; i.e. whether there's even a small (>10%) chance it has changed. If it is unstable, you must verify with browsing the internet for verification.\n\n<situations_where_you_must_browse_the_internet>\nBelow is a list of scenarios where browsing the internet MUST be used. PAY CLOSE ATTENTION: you MUST browse the internet in these cases. If you're unsure or on the fence, you MUST bias towards browsing the internet.\n- The information could have changed recently: for example news; prices; laws; schedules; product specs; sports scores; economic indicators; political/public/company figures (e.g. the question relates to 'the president of country A' or 'the CEO of company B', which might change over time); rules; regulations; standards; software libraries that could be updated; exchange rates; recommendations (i.e., recommendations about various topics or things might be informed by what currently exists / is popular / is safe / is unsafe / is in the zeitgeist / etc.); and many many many more categories -- again, if you're on the fence, you MUST browse the internet!\n  - For news queries, prioritize more recent events, ensuring you compare publish dates and the date that the event happened.\n- The user is seeking recommendations that could lead them to spend substantial time or money -- researching products, restaurants, travel plans, etc.\n- The user wants (or would benefit from) direct quotes, links, or precise source attribution.\n- A specific page, paper, dataset, PDF, or site is referenced and you haven't been given its contents.\n- You're unsure about a fact, the topic is niche or emerging, or you suspect there's at least a 10% chance you will incorrectly recall it\n- High-stakes accuracy matters (medical, legal, financial guidance). For these you generally should search by default because this information is highly temporally unstable\n- The user explicitly says to search, browse, verify, or look it up.\n</situations_where_you_must_browse_the_internet>\n\n---\n\n## Citations\n\nResults from `web.run` include internal reference IDs such as `turn2search5`. Use\nthose reference IDs only in calls to `web.run`; do not expose them in the final\nresponse.\n\nCite sources in the final response using Markdown links:\n\n- Cite a single source as `[descriptive source title](https://example.com/page)`.\n- Cite multiple sources with separate Markdown links, for example\n  `[first source](https://example.com/one), [second source](https://example.com/two)`.\n- Link directly to the page that supports the claim. Do not link to search result\n  pages or use bare URLs.\n\nFormatting of citations:\n\n- Place each citation as near as possible to the claim it supports, normally at\n  the end of the sentence or paragraph and after punctuation.\n- Do not place citations inside code fences.\n- Do not put citations on a line by themselves or collect all citations at the\n  end of the response.\n\nIf you browse the internet, cite statements supported by web sources. Each cited\nsource must directly support the associated claim. Prefer primary and\nauthoritative sources, and use sources from different domains when the response\nbenefits from multiple perspectives.\n\n---\n\n## Special cases\nIf these conflict with any other instructions, these should take precedence.\n\n<special_cases>\n- When the user asks for information about how to use OpenAI products, (ChatGPT, the OpenAI API, etc.), you should check the code in local env and only browse as fallback, when you browse restrict your sources to official OpenAI websites using the domains filter, unless otherwise requested.\n- When using search to answer technical questions, you must only rely on primary sources (research papers, official documentation, etc.)\n- Clearly indicate when you are making an inference from sources.\n</special_cases>\n\n---\n\n## Word limits\nResponses may not excessively quote or draw on a specific source. There are several limits here:\n- **Limit on verbatim quotes:**\n  - You may not quote more than 25 words verbatim from any single non-lyrical source, unless the source is reddit.\n  - For song lyrics, verbatim quotes must be limited to at most 10 words.\n  - Long quotes from reddit are allowed, as long as you indicate that those are direct quotes via a markdown blockquote starting with \">\", copy verbatim, and link the source.\n- **Word limits:**\n  - Each webpage source in the sources has a word limit label formatted like \"[wordlim N]\", in which N is the maximum number of words in the whole response that are attributed to that source. If omitted, the word limit is 200 words.\n  - Non-contiguous words derived from a given source must be counted to the word limit.\n  - The summarization limit N is a maximum for each source.\n  - When using multiple sources, their summarization limits add together. However, each article used must be relevant to the response.\n- **Copyright compliance:**\n  - You must avoid providing full articles, long verbatim passages, or extensive direct quotes due to copyright concerns.\n  - If the user asked for a verbatim quote, the response should provide a short compliant excerpt and then answer with paraphrases and summaries.\n  - Again, this limit does not apply to reddit content, as long as it's appropriately indicated that those are direct quotes and you link to the source.\n",
        "name": "run",
        "parameters": {
          "properties": {
            "click": {
              "description": "Open links from previously opened pages.",
              "items": {
                "properties": {
                  "id": {
                    "description": "Numbered link id to open.",
                    "type": "integer"
                  },
                  "ref_id": {
                    "description": "Reference id containing the numbered link.",
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "ref_id"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "finance": {
              "description": "Look up prices for the given stock symbols.",
              "items": {
                "properties": {
                  "market": {
                    "description": "ISO 3166-1 alpha-3 country code, \"OTC\", or \"\" for cryptocurrency.",
                    "type": "string"
                  },
                  "ticker": {
                    "description": "Ticker symbol to look up.",
                    "type": "string"
                  },
                  "type": {
                    "description": "Asset type to look up.",
                    "enum": [
                      "equity",
                      "fund",
                      "crypto",
                      "index"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "ticker",
                  "type"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "find": {
              "description": "Find text patterns in pages.",
              "items": {
                "properties": {
                  "pattern": {
                    "description": "Text pattern to find.",
                    "type": "string"
                  },
                  "ref_id": {
                    "description": "Reference id or URL to search within.",
                    "type": "string"
                  }
                },
                "required": [
                  "pattern",
                  "ref_id"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "image_query": {
              "description": "Query the image search engine for a given list of queries.",
              "items": {
                "properties": {
                  "domains": {
                    "description": "Whether to filter by a specific list of domains.",
                    "items": {
                      "type": "string"
                    },
                    "type": "array"
                  },
                  "q": {
                    "description": "Search query.",
                    "type": "string"
                  },
                  "recency": {
                    "description": "Whether to filter by recency, as a number of recent days.",
                    "type": "integer"
                  }
                },
                "required": [
                  "q"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "open": {
              "description": "Open pages by reference id or URL.",
              "items": {
                "properties": {
                  "lineno": {
                    "description": "Line number to position the page at.",
                    "type": "integer"
                  },
                  "ref_id": {
                    "description": "Reference id or URL to open.",
                    "type": "string"
                  }
                },
                "required": [
                  "ref_id"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "response_length": {
              "description": "Set the length of the response to be returned.",
              "enum": [
                "short",
                "medium",
                "long"
              ],
              "type": "string"
            },
            "screenshot": {
              "description": "Take screenshots of PDF pages.",
              "items": {
                "properties": {
                  "pageno": {
                    "description": "Zero-indexed PDF page number.",
                    "type": "integer"
                  },
                  "ref_id": {
                    "description": "Reference id or URL to screenshot.",
                    "type": "string"
                  }
                },
                "required": [
                  "pageno",
                  "ref_id"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "search_query": {
              "description": "Query the internet search engine for a given list of queries.",
              "items": {
                "properties": {
                  "domains": {
                    "description": "Whether to filter by a specific list of domains.",
                    "items": {
                      "type": "string"
                    },
                    "type": "array"
                  },
                  "q": {
                    "description": "Search query.",
                    "type": "string"
                  },
                  "recency": {
                    "description": "Whether to filter by recency, as a number of recent days.",
                    "type": "integer"
                  }
                },
                "required": [
                  "q"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "sports": {
              "description": "Look up sports schedules and standings.",
              "items": {
                "properties": {
                  "date_from": {
                    "description": "Start date in YYYY-MM-DD format.",
                    "type": "string"
                  },
                  "date_to": {
                    "description": "End date in YYYY-MM-DD format.",
                    "type": "string"
                  },
                  "fn": {
                    "description": "Sports function to call.",
                    "enum": [
                      "schedule",
                      "standings"
                    ],
                    "type": "string"
                  },
                  "league": {
                    "description": "League to look up.",
                    "enum": [
                      "nba",
                      "wnba",
                      "nfl",
                      "nhl",
                      "mlb",
                      "epl",
                      "ncaamb",
                      "ncaawb",
                      "ipl"
                    ],
                    "type": "string"
                  },
                  "locale": {
                    "description": "Locale for the lookup.",
                    "type": "string"
                  },
                  "num_games": {
                    "description": "Number of games to return.",
                    "type": "integer"
                  },
                  "opponent": {
                    "description": "Opponent to use with `team` when narrowing the lookup.",
                    "type": "string"
                  },
                  "team": {
                    "description": "Team to look up, using the common 3 or 4 letter alias used in broadcasts.",
                    "type": "string"
                  },
                  "tool": {
                    "description": "Tool name for sports requests.",
                    "enum": [
                      "sports"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "fn",
                  "league"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "time": {
              "description": "Get time for the given UTC offsets.",
              "items": {
                "properties": {
                  "utc_offset": {
                    "description": "UTC offset formatted like \"+03:00\".",
                    "type": "string"
                  }
                },
                "required": [
                  "utc_offset"
                ],
                "type": "object"
              },
              "type": "array"
            },
            "weather": {
              "description": "Look up weather forecasts.",
              "items": {
                "properties": {
                  "duration": {
                    "description": "Number of days to return. Defaults to 7.",
                    "type": "integer"
                  },
                  "location": {
                    "description": "Location in \"Country, Area, City\" format.",
                    "type": "string"
                  },
                  "start": {
                    "description": "Start date in YYYY-MM-DD format. Defaults to today.",
                    "type": "string"
                  }
                },
                "required": [
                  "location"
                ],
                "type": "object"
              },
              "type": "array"
            }
          },
          "type": "object"
        },
        "strict": false,
        "type": "function"
      }
    ],
    "type": "namespace"
  }
} as const;
export const PI_CORE_TOOL_PARAMETERS = {
  "apply_patch": {
    "type": "object",
    "properties": {
      "input": {
        "type": "string"
      }
    },
    "required": [
      "input"
    ],
    "additionalProperties": false
  }
} as const;
