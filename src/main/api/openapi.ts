/**
 * OpenAPI 3.0 specification for the QuietClaw REST API.
 *
 * Served at GET /api/v1/openapi.json
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'QuietClaw API',
    description:
      'Local REST API for accessing meeting transcripts, summaries, and action items. Runs on localhost inside the QuietClaw Electron app.',
    version: '0.1.0',
    license: { name: 'Apache-2.0', url: 'https://github.com/laszlokorsos/quietclaw/blob/main/LICENSE' }
  },
  servers: [{ url: 'http://localhost:19832', description: 'Local QuietClaw instance' }],
  paths: {
    '/api/v1/health': {
      get: {
        summary: 'Health check',
        operationId: 'getHealth',
        tags: ['System'],
        responses: {
          200: {
            description: 'Server is running',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    version: { type: 'string', example: '0.1.0' },
                    uptime: { type: 'number', description: 'Server uptime in seconds', example: 3600 }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/v1/meetings': {
      get: {
        summary: 'List meetings (paginated)',
        operationId: 'listMeetings',
        tags: ['Meetings'],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 }, description: 'Max results to return' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Number of results to skip' }
        ],
        responses: {
          200: {
            description: 'Paginated meeting list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    meetings: { type: 'array', items: { $ref: '#/components/schemas/MeetingListItem' } },
                    total: { type: 'integer', description: 'Total number of meetings' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/v1/meetings/today': {
      get: {
        summary: "Today's meetings",
        operationId: 'getTodayMeetings',
        tags: ['Meetings'],
        responses: {
          200: {
            description: "List of today's meetings",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    meetings: { type: 'array', items: { $ref: '#/components/schemas/MeetingListItem' } },
                    date: { type: 'string', format: 'date', example: '2026-04-04' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/v1/meetings/search': {
      get: {
        summary: 'Full-text search across meetings',
        operationId: 'searchMeetings',
        tags: ['Meetings'],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }
        ],
        responses: {
          200: {
            description: 'Search results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    meetings: { type: 'array', items: { $ref: '#/components/schemas/MeetingListItem' } },
                    query: { type: 'string' },
                    count: { type: 'integer' }
                  }
                }
              }
            }
          },
          400: { description: 'Missing search query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}': {
      get: {
        summary: 'Get meeting metadata',
        operationId: 'getMeeting',
        tags: ['Meetings'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Meeting metadata', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeetingMetadata' } } } },
          404: { description: 'Meeting not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      },
      delete: {
        summary: 'Delete a meeting and all its files',
        operationId: 'deleteMeeting',
        tags: ['Meetings'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Meeting deleted', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
          404: { description: 'Meeting not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}/transcript': {
      get: {
        summary: 'Get meeting transcript',
        operationId: 'getTranscript',
        tags: ['Transcripts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Full transcript', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transcript' } } } },
          404: { description: 'Meeting or transcript not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}/summary': {
      get: {
        summary: 'Get meeting summary',
        operationId: 'getSummary',
        tags: ['Summaries'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Meeting summary', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeetingSummary' } } } },
          404: { description: 'Meeting not found or not yet summarized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}/actions': {
      get: {
        summary: 'Get action items',
        operationId: 'getActions',
        tags: ['Actions'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Action items list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    actions: { type: 'array', items: { $ref: '#/components/schemas/ActionItem' } }
                  }
                }
              }
            }
          },
          404: { description: 'Meeting not found or no actions', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}/summarize': {
      post: {
        summary: 'Trigger on-demand summarization',
        operationId: 'summarizeMeeting',
        tags: ['Summaries'],
        description: 'Run AI summarization on an existing transcript. Useful for meetings that were recorded without summarization enabled, or to re-summarize with updated settings.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Summarization complete',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    summary: { $ref: '#/components/schemas/MeetingSummary' },
                    actions: { type: 'array', items: { $ref: '#/components/schemas/ActionItem' } }
                  }
                }
              }
            }
          },
          400: { description: 'Anthropic API key not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Meeting or transcript not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/meetings/{id}/actions/{aid}': {
      post: {
        summary: 'Update action item status',
        operationId: 'updateActionStatus',
        tags: ['Actions'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'aid', in: 'path', required: true, schema: { type: 'string' }, description: 'Action item ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Action updated', content: { 'application/json': { schema: { type: 'object', properties: { action: { $ref: '#/components/schemas/ActionItem' } } } } } },
          400: { description: 'Invalid status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Meeting or action not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/api/v1/config': {
      get: {
        summary: 'Get current configuration (safe fields only)',
        operationId: 'getConfig',
        tags: ['System'],
        responses: {
          200: {
            description: 'Current configuration (secrets excluded)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    general: {
                      type: 'object',
                      properties: {
                        data_dir: { type: 'string' },
                        retain_audio: { type: 'boolean' },
                        markdown_output: { type: 'boolean' }
                      }
                    },
                    stt: {
                      type: 'object',
                      properties: {
                        provider: { type: 'string' },
                        model: { type: 'string' },
                        language: { type: 'string' }
                      }
                    },
                    summarization: {
                      type: 'object',
                      properties: {
                        enabled: { type: 'boolean' },
                        provider: { type: 'string' },
                        model: { type: 'string' }
                      }
                    },
                    api: { type: 'object', properties: { enabled: { type: 'boolean' }, port: { type: 'integer' } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Optional. Auto-generated token stored in OS keychain. If no Authorization header is sent, access is granted (localhost-only).'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Human-readable error message' }
        },
        required: ['error']
      },
      MeetingListItem: {
        type: 'object',
        description: 'Meeting summary returned in list endpoints',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string', example: 'Weekly Standup' },
          slug: { type: 'string', example: 'weekly-standup-a1b2' },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
          duration: { type: 'number', description: 'Duration in seconds' },
          date: { type: 'string', format: 'date' },
          speakers: {
            type: 'array',
            items: { type: 'string' },
            example: ['Laszlo Korsos', 'Speaker A']
          },
          summarized: { type: 'boolean' },
          sttProvider: { type: 'string', example: 'deepgram' }
        }
      },
      MeetingMetadata: {
        type: 'object',
        description: 'Full meeting metadata (returned from GET /meetings/:id)',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          slug: { type: 'string' },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
          duration: { type: 'number' },
          calendarEvent: { $ref: '#/components/schemas/CalendarEventInfo' },
          speakers: { type: 'array', items: { $ref: '#/components/schemas/SpeakerInfo' } },
          summarized: { type: 'boolean' },
          sttProvider: { type: 'string' },
          summarizationProvider: { type: 'string', nullable: true },
          files: {
            type: 'object',
            properties: {
              metadata: { type: 'string' },
              transcript_json: { type: 'string' },
              transcript_md: { type: 'string' },
              summary_json: { type: 'string' },
              summary_md: { type: 'string' },
              actions_json: { type: 'string' },
              audio: { type: 'string' }
            }
          }
        }
      },
      CalendarEventInfo: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          calendarAccountEmail: { type: 'string', format: 'email' },
          title: { type: 'string' },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
          attendees: { type: 'array', items: { $ref: '#/components/schemas/CalendarAttendee' } },
          meetingLink: { type: 'string', format: 'uri' },
          platform: { type: 'string', enum: ['google_meet', 'zoom', 'teams', 'other'] }
        }
      },
      CalendarAttendee: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          self: { type: 'boolean' },
          responseStatus: { type: 'string', enum: ['accepted', 'declined', 'tentative', 'needsAction'] }
        }
      },
      SpeakerInfo: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name (real name or "Speaker A/B/C")' },
          speakerId: { type: 'integer', description: 'Raw speaker ID from STT provider' },
          source: { type: 'string', enum: ['microphone', 'system'], description: 'microphone = you, system = remote participants' },
          email: { type: 'string', format: 'email', description: 'Email if known from calendar' }
        }
      },
      Transcript: {
        type: 'object',
        properties: {
          segments: { type: 'array', items: { $ref: '#/components/schemas/TranscriptSegment' } },
          duration: { type: 'number', description: 'Total audio duration in seconds' },
          provider: { type: 'string', example: 'deepgram' },
          model: { type: 'string', example: 'nova-2' },
          language: { type: 'string', example: 'en' }
        }
      },
      TranscriptSegment: {
        type: 'object',
        properties: {
          speaker: { type: 'string', description: 'Speaker name or anonymous label' },
          speakerId: { type: 'integer' },
          source: { type: 'string', enum: ['microphone', 'system'] },
          start: { type: 'number', description: 'Segment start time in seconds' },
          end: { type: 'number', description: 'Segment end time in seconds' },
          text: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          words: {
            type: 'array',
            description: 'Per-word timing (optional)',
            items: {
              type: 'object',
              properties: {
                word: { type: 'string' },
                start: { type: 'number' },
                end: { type: 'number' },
                confidence: { type: 'number' },
                punctuated_word: { type: 'string' }
              }
            }
          }
        }
      },
      MeetingSummary: {
        type: 'object',
        properties: {
          executive_summary: { type: 'string', description: '2-3 sentence executive summary' },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                participants: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' }
              }
            }
          },
          decisions: { type: 'array', items: { type: 'string' } },
          sentiment: { type: 'string', description: 'Overall tone of the meeting' },
          provider: { type: 'string', example: 'anthropic' },
          model: { type: 'string', example: 'claude-haiku-4-5-20251001' }
        }
      },
      ActionItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          assignee: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          agent_executable: { type: 'boolean', description: 'Whether an AI agent could perform this action (e.g., file an issue, send an email)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          due_date: { type: 'string', format: 'date', description: 'Due date if mentioned (ISO 8601)' }
        }
      }
    }
  },
  security: [{ bearerAuth: [] }]
}
