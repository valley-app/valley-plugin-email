# Email

Built-in email client. Gmail and Microsoft accounts are signed in once in Settings → Accounts (shared with Calendar); generic SMTP/IMAP (PureMail) mailboxes are added here. Left-sidebar account/folder list, right-sidebar message preview, and a full workspace page to read, sync and compose.

Global Content Search includes synced message subjects, senders, recipients, and complete text/HTML bodies through the SDK dataset search contract. Settings → Search → Content Search controls Email independently. Selecting a result opens the message in its current account and folder. Messages must be synced before their content is searchable.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Valley ships this core plugin as a verified release artifact in its application resources. Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. The core package and its locale files are never installed into `.valley`; ordinary vault documents and saved plugin data retain their existing locations.

## Filters and automatic groups

Account and mailbox controls expand inline. Email resolves names and photos through Contacts, stores VIP addresses separately from message flags, and filters contact status, VIP, provider spam status, and virtual categories before SQLite pagination. The reader keeps one scroll area; full addresses and composer Cc/Bcc fields expand on demand.

Choose Jev or Laya under Valley’s AI Providers and set the shared Classification default. Email uses shared groups, with its own enabled categories and descriptions under Email Settings → Groups. Laya runs separately on loopback; model installation and server lifecycle stay outside Valley. There is no automatic cloud fallback.

Automatic grouping is opt-in and applies to newly arrived, unread, non-spam Inbox messages after a sync baseline. Its default allowance is 100 messages per account in a rolling 24 hours. Initial syncs, historical imports, cache rebuilds, and UIDVALIDITY resets do not automatically enqueue old mail. Use Classify existing mail to select historical messages explicitly. Provider limits and budgets apply to both paths.

Categories never move messages or change spam status. Manual category assignments remain durable across cache rebuilds and block in-flight automatic results until Reset to automatic. Queue records contain identifiers and progress; provider input includes sender, subject, and normalized body without attachments or remote images. Interrupted or ambiguous requests require an explicit action before retrying.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface and background engine.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.
