# Image and video generation

0G's image and video models sit in the same model menu as chat models, under
their own headings. Choosing one and sending a prompt generates the file, saves
it in the conversation and shows it in the reply.

## How a request runs

A media model uses the ordinary run path, so leases, cancellation and failure
reasons all work as they do for chat. Only the provider call differs: the API
answers the worker with a one-message stream, so the worker has no media code.

1. The API sends the newest member message as the prompt. Earlier messages and
   attachments are not sent.
2. An image is requested from `POST /v1/images/generations` as base64. A video
   is submitted to `POST /v1/videos`, polled every 5 seconds at
   `GET /v1/videos/{id}`, then downloaded from `GET /v1/videos/{id}/content`.
3. The file is saved under `generated/` before the reply is sent, because 0G
   keeps finished clips for a limited time.

Clips use the model's default length, which 0G publishes in the model listing,
and 0G's default resolution and aspect ratio.

## Limits

| Limit | Value |
| --- | --- |
| One image request | 5 minutes |
| One video | 13 minutes, inside the worker's 15-minute run budget |
| One generated file | 256 MiB |
| Generated files in one conversation | 2 GiB |

A run cancelled before a clip finishes leaves the job at 0G, which charges for a
video once it is polled or downloaded after completion.

## Access and cost

Administrators see these models in the same place as chat models. Providers
that sync their models enable them automatically, and an explicit block still
wins. New conversations always start on a chat model.

The menu shows 0G's published price. Media spend is billed by 0G and does not
appear in Lori's token usage totals.

A refusal or failed job uses the normal [failure reasons](WORK_CLOUD.md#failure-reasons).
