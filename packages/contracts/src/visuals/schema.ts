// Closed catalog shared by server admission and browser history validation.
export const cloudVisualSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "title", "summary", "blocks"],
  "properties": {
    "version": { "type": "integer", "enum": [1] },
    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
    "summary": { "type": "string", "minLength": 1, "maxLength": 1200, "description": "Readable takeaway, including material assumptions. Also used if the visualization cannot render." },
    "sources": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "object", "additionalProperties": false, "required": ["label", "reference"], "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 120}, "reference": {"type": "string", "minLength": 1, "maxLength": 400}}}, "description": "Optional source notes. Exact file/version/page or citation reference from material actually read; plain text, never actions. Omit when not grounded in sources."},
    "blocks": {
      "type": "array", "minItems": 1, "maxItems": 6,
      "items": {
        "anyOf": [
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "items"],
            "properties": {
              "type": { "type": "string", "enum": ["metrics"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "items": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["label", "value"],
                  "properties": {
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "value": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "detail": { "type": "string", "maxLength": 240 }
                  }
                }
              }
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "chartType", "labels", "series", "xLabel", "yLabel"],
            "properties": {
              "type": { "type": "string", "enum": ["chart"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "chartType": { "type": "string", "enum": ["bar", "line"] },
              "xLabel": { "type": "string", "minLength": 1, "maxLength": 80 },
              "yLabel": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Measure and units, e.g. Revenue (INR)." },
              "labels": { "type": "array", "minItems": 1, "maxItems": 40, "items": { "type": "string", "minLength": 1, "maxLength": 80 } },
              "series": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["name", "values"],
                  "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "values": { "type": "array", "minItems": 1, "maxItems": 40, "items": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 }, "description": "Exactly one finite number per label, in the same order. Aggregate large datasets before presenting." }
                  }
                }
              }
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "columns", "rows"],
            "properties": {
              "type": { "type": "string", "enum": ["table"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "columns": { "type": "array", "minItems": 1, "maxItems": 6, "items": { "type": "string", "minLength": 1, "maxLength": 80 } },
              "rows": {
                "type": "array", "minItems": 1, "maxItems": 100,
                "items": { "type": "array", "minItems": 1, "maxItems": 6, "items": { "anyOf": [ { "type": "string", "maxLength": 300 }, { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 } ] } },
                "description": "One cell per column. Use for searchable, sortable comparisons."
              }
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "inputs", "outputs"],
            "properties": {
              "type": { "type": "string", "enum": ["calculator"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "inputs": {
                "type": "array", "minItems": 1, "maxItems": 6,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["id", "label", "min", "max", "step", "value"],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 32, "description": "Unique input identifier: letters, digits, underscores; start with a letter." },
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "min": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "max": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "step": { "type": "number", "minimum": 0.000001, "maximum": 1000000000000 },
                    "value": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "unit": { "type": "string", "maxLength": 24 }
                  }
                }
              },
              "outputs": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["label", "expression"],
                  "properties": {
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "expression": {
                      "anyOf": [
                        { "type": "string", "minLength": 1, "maxLength": 512 },
                        { "type": "array", "minItems": 1, "maxItems": 64, "items": { "anyOf": [ { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 }, { "type": "string", "minLength": 1, "maxLength": 32 } ] } }
                      ],
                      "description": "Prefer ordinary arithmetic: (price-cost)*quantity. Operators + - * / ^, parentheses, min(a,b), max(a,b), abs(a), round(a), sin/cos/tan/sqrt/log/exp(a); input IDs and numeric literals only. Legacy postfix token arrays also work. Must produce one finite result at default inputs."
                    },
                    "unit": { "type": "string", "maxLength": 24 },
                    "precision": { "type": "integer", "minimum": 0, "maximum": 6 }
                  }
                }
              },
              "note": { "type": "string", "maxLength": 600, "description": "Explain the calculation, assumptions, and units in plain language." }
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "items"],
            "properties": {
              "type": { "type": "string", "enum": ["steps"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "items": {
                "type": "array", "minItems": 2, "maxItems": 12,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["title", "text"],
                  "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "text": { "type": "string", "minLength": 1, "maxLength": 1600 }
                  }
                }
              }
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["type", "title", "inputs", "timeline", "outputs", "view"],
            "properties": {
              "type": { "type": "string", "enum": ["simulation"] },
              "title": { "type": "string", "minLength": 1, "maxLength": 120 },
              "inputs": {
                "type": "array", "maxItems": 5,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["id", "label", "min", "max", "step", "value"],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 32 },
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "min": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "max": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "step": { "type": "number", "minimum": 0.000001, "maximum": 1000000000000 },
                    "value": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                    "unit": { "type": "string", "maxLength": 24 }
                  }
                }
              },
              "timeline": {
                "type": "object", "additionalProperties": false, "required": ["id", "label", "min", "max", "step", "value", "rate"],
                "properties": {
                  "id": { "type": "string", "minLength": 1, "maxLength": 32 },
                  "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                  "min": { "type": "number", "minimum": 0, "maximum": 3600 },
                  "max": { "type": "number", "minimum": 0, "maximum": 3600 },
                  "step": { "type": "number", "minimum": 0.000001, "maximum": 3600 },
                  "value": { "type": "number", "minimum": 0, "maximum": 3600 },
                  "unit": { "type": "string", "maxLength": 24 },
                  "rate": { "type": "number", "minimum": 0.01, "maximum": 1000, "description": "Timeline units per real second. Use 1 for real-time physics. Playback starts paused." }
                }
              },
              "outputs": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                  "type": "object", "additionalProperties": false, "required": ["label", "expression"],
                  "properties": {
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "expression": { "type": "string", "minLength": 1, "maxLength": 512 },
                    "unit": { "type": "string", "maxLength": 24 },
                    "precision": { "type": "integer", "minimum": 0, "maximum": 6 }
                  }
                }
              },
              "view": {
                "anyOf": [
                  {
                    "type": "object", "additionalProperties": false, "required": ["type", "label", "min", "max", "items"],
                    "properties": {
                      "type": { "type": "string", "enum": ["track"] },
                      "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                      "min": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "max": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "unit": { "type": "string", "maxLength": 24 },
                      "items": { "type": "array", "minItems": 1, "maxItems": 4, "items": {
                        "type": "object", "additionalProperties": false, "required": ["label", "expression"],
                        "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80 }, "expression": { "type": "string", "minLength": 1, "maxLength": 512 } }
                      } }
                    }
                  },
                  {
                    "type": "object", "additionalProperties": false, "required": ["type", "xLabel", "yLabel", "xMin", "xMax", "yMin", "yMax", "items"],
                    "properties": {
                      "type": { "type": "string", "enum": ["plane"] },
                      "xLabel": { "type": "string", "minLength": 1, "maxLength": 80 },
                      "yLabel": { "type": "string", "minLength": 1, "maxLength": 80 },
                      "xMin": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "xMax": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "yMin": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "yMax": { "type": "number", "minimum": -1000000000000, "maximum": 1000000000000 },
                      "items": { "type": "array", "minItems": 1, "maxItems": 4, "items": {
                        "type": "object", "additionalProperties": false, "required": ["label", "x", "y"],
                        "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80 }, "x": { "type": "string", "minLength": 1, "maxLength": 512 }, "y": { "type": "string", "minLength": 1, "maxLength": 512 } }
                      } }
                    }
                  }
                ]
              },
              "note": { "type": "string", "maxLength": 600 }
            }
          },
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "direction", "nodes", "edges"], "properties": {"type": {"type": "string", "enum": ["diagram"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "direction": {"type": "string", "enum": ["down", "right"]}, "nodes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["id", "label"], "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 32}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "detail": {"type": "string", "minLength": 1, "maxLength": 600}}}}, "edges": {"type": "array", "minItems": 0, "maxItems": 32, "items": {"type": "object", "additionalProperties": false, "required": ["from", "to"], "properties": {"from": {"type": "string", "minLength": 1, "maxLength": 32}, "to": {"type": "string", "minLength": 1, "maxLength": 32}, "label": {"type": "string", "minLength": 1, "maxLength": 80}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "nodes"], "properties": {"type": {"type": "string", "enum": ["mindmap"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "nodes": {"type": "array", "minItems": 1, "maxItems": 60, "items": {"type": "object", "additionalProperties": false, "required": ["id", "label"], "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 32}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "parentId": {"type": "string", "minLength": 1, "maxLength": 32}, "detail": {"type": "string", "minLength": 1, "maxLength": 600}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "items"], "properties": {"type": {"type": "string", "enum": ["timeline"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["label", "title", "text"], "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 80}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "text": {"type": "string", "minLength": 1, "maxLength": 1000}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "questions"], "properties": {"type": {"type": "string", "enum": ["quiz"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "questions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["question", "options", "answer", "explanation"], "properties": {"question": {"type": "string", "minLength": 1, "maxLength": 500}, "options": {"type": "array", "minItems": 2, "maxItems": 6, "items": {"type": "string", "minLength": 1, "maxLength": 240}}, "answer": {"type": "integer", "minimum": 0, "maximum": 5}, "explanation": {"type": "string", "minLength": 1, "maxLength": 1000}, "hint": {"type": "string", "minLength": 1, "maxLength": 300}, "rationales": {"type": "array", "minItems": 2, "maxItems": 6, "items": {"type": "string", "minLength": 1, "maxLength": 400}}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "cards"], "properties": {"type": {"type": "string", "enum": ["flashcards"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "cards": {"type": "array", "minItems": 1, "maxItems": 30, "items": {"type": "object", "additionalProperties": false, "required": ["front", "back"], "properties": {"front": {"type": "string", "minLength": 1, "maxLength": 500}, "back": {"type": "string", "minLength": 1, "maxLength": 1600}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "slides"], "properties": {"type": {"type": "string", "enum": ["slides"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "slides": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["layout", "title"], "properties": {"layout": {"type": "string", "enum": ["title", "section", "bullets", "statement", "stats", "columns", "chart", "closing"]}, "kicker": {"type": "string", "minLength": 1, "maxLength": 60}, "title": {"type": "string", "minLength": 1, "maxLength": 140}, "subtitle": {"type": "string", "minLength": 1, "maxLength": 280}, "bullets": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "string", "minLength": 1, "maxLength": 180}}, "stats": {"type": "array", "minItems": 1, "maxItems": 4, "items": {"type": "object", "additionalProperties": false, "required": ["value", "label"], "properties": {"value": {"type": "string", "minLength": 1, "maxLength": 24}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "detail": {"type": "string", "minLength": 1, "maxLength": 160}}}}, "columns": {"type": "array", "minItems": 2, "maxItems": 3, "items": {"type": "object", "additionalProperties": false, "required": ["heading", "text"], "properties": {"heading": {"type": "string", "minLength": 1, "maxLength": 80}, "text": {"type": "string", "minLength": 1, "maxLength": 600}}}}, "chart": {"type": "object", "additionalProperties": false, "required": ["chartType", "labels", "series"], "properties": {"chartType": {"type": "string", "enum": ["bar", "line"]}, "labels": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "string", "minLength": 1, "maxLength": 40}}, "series": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "object", "additionalProperties": false, "required": ["name", "values"], "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 60}, "values": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "number", "minimum": -1000000000000, "maximum": 1000000000000}}}}}, "unit": {"type": "string", "minLength": 1, "maxLength": 24}}}, "notes": {"type": "string", "minLength": 1, "maxLength": 1200}}}}}},
          {"type": "object", "additionalProperties": false, "required": ["type", "title", "sections"], "properties": {"type": {"type": "string", "enum": ["report"]}, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "sections": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "object", "additionalProperties": false, "required": ["heading", "body"], "properties": {"heading": {"type": "string", "minLength": 1, "maxLength": 120}, "body": {"type": "string", "minLength": 1, "maxLength": 4000}}}}}}
        ]
      }
    }
  }
} as const;
