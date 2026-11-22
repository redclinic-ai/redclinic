# KNOWN_ISSUES

## K1: Package installs are blocked (blocker for the app scaffold)
The account network setting blocks npm and pip. Next.js, a Postgres driver and test tooling cannot be installed here. Work that needs no packages (SQL migrations, SQL tests, documents) continues.
Needed from the founder: update the network settings to allow package installs, then start a new chat (the current chat may not pick up the change), or run this build in a Claude Code session on the machine with the GitHub repository.

## K2: Product specification and Dental Pack specification not supplied
The master prompt names them as the source of truth for functionality and the Dental Pack workflows. Only the master prompt itself was provided. Needed: the V1 specification file and the Dental Pack workflow specification.

## K3: Master prompt copy provided to the earlier chat was truncated at section 14
Resolved: the complete final master prompt (`docs/MASTER_PROMPT.md`) was used.

- K4: The Dental Pack in migration 005 is an engineering draft, not the founder's specification. Review with a dental professional before any real patient contact. Replace or version it (pack version 2) when the spec arrives.

- K2 update: the V1 Product Specification has now been supplied (docs/PRODUCT_SPEC.md). The separate Dental Pack specification has not; the spec only says the pack includes RCT, braces and recall workflows. K4 still applies.
