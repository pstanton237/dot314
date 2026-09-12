# image-url-broker

Publishes outgoing Pi images as stable HTTPS files and replaces repeated inline base64 in supported provider requests with those URLs. Images attached through `screenshots-picker`, pasted into Pi, or returned by tools all use the same downstream provider-payload optimization.

## Installation

Install dot314, enable `image-url-broker` with `pi config`, and create the configuration described below:

```bash
pi install git:github.com/w-winter/dot314
```

## Requirements

Provide a static HTTPS mapping from a public URL prefix to a local directory. The provider must be able to fetch each URL without authentication.

For example:

```text
https://images.example.org/pi/<filename> → /srv/pi-images/<filename>
```

The static service must return the stored bytes unchanged with the matching image `Content-Type`. Keep URLs and files available while their images can recur in conversation context, and disable directory listing.

## Configuration

The extension remains inactive when `config.json` is absent, so Pi can start before publication is configured. Copy `config.json.example` to `config.json` in this directory and set both fields to enable it:

```json
{
  "publicBaseUrl": "https://images.example.org/pi/",
  "outputDirectory": "/srv/pi-images"
}
```

- `publicBaseUrl` is an absolute HTTPS URL without credentials, query, or fragment. Path prefixes and explicit HTTPS ports are supported.
- `outputDirectory` is an absolute path. The extension creates it when needed. A symlink that resolves to a directory is supported.

The configuration is strict: both fields are required, unknown fields are rejected, and invalid or unreadable configuration fails extension loading with an `image-url-broker` error.

`config.json` is ignored by Git because it contains machine-local serving paths and URLs.

Pi auto-discovers `~/.pi/agent/extensions/image-url-broker/index.ts`. Run `/reload` after adding the extension or changing its configuration.

## Source and attribution

The design draws on the provider-rewrite, publication, and stream-recovery architecture of [can1357/oh-my-pi's blob broker](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/blob-broker). This implementation packages the relevant behavior as a Pi extension for a user-configured static HTTPS directory.

## Supported providers

The extension rewrites these exact first-party Pi targets when the model declares image input:

- Direct Anthropic Messages: `anthropic` / `anthropic-messages` at `https://api.anthropic.com`
- OpenAI Chat Completions: `openai` / `openai-completions` at `https://api.openai.com/v1`
- OpenAI Responses: `openai` / `openai-responses` at `https://api.openai.com/v1`
- OpenAI Codex Responses: `openai-codex` / `openai-codex-responses` at `https://chatgpt.com/backend-api`

Azure OpenAI, provider endpoint overrides, gateways, and other providers keep Pi's ordinary inline image representation.

## Publication behavior

JPEG, PNG, GIF, and WebP images use content-addressed filenames. The filename is stable for the same MIME type and base64 content, so repeated turns and concurrent Pi sessions reuse the same public URL. Published files contain the exact decoded bytes; the extension does not resize or transcode images.

Pi session data remains ordinary base64 `ImageContent`. Unloading the extension immediately restores inline provider requests without migrating sessions.

A local parsing or filesystem publication error is reported, and Pi retains the previous inline payload. If a URL-bearing Codex attempt fails before emitting response content, the extension reports the recovery and retries that turn once with inline image data. A successful inline retry disables URL delivery for later Codex requests in the current Pi session. Aborted requests and failures after response content begins are not retried.

## Privacy and retention

Published images are public resources. Content hashes make filenames difficult to guess, but they are not authentication or access control. Restrict local write access to the Pi user, expose only the configured directory, and never rely on directory-name secrecy.

Files remain in `outputDirectory` until you remove them. Remove files only after unloading the extension and allowing in-flight requests to finish; deleting an image still referenced by conversation context can break a later provider request.

Changing `publicBaseUrl` changes the URL sent for existing images and may invalidate provider caches. Changing `outputDirectory` requires preserving the files served by existing URLs.

## Verification

After sending one known image through a supported provider:

1. Confirm `outputDirectory` contains one `<sha256>.<suffix>` file.
2. Fetch its public URL from outside the local network when possible.
3. Confirm status `200`, the expected image `Content-Type`, and byte-for-byte equality with the stored file.
4. Send the same image again and confirm the filename and URL remain unchanged.
5. Inspect the Pi session and confirm it still contains the ordinary base64 image rather than the public URL.
