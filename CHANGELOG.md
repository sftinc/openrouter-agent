# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0](https://github.com/sftinc/openrouter-agent/compare/v1.2.2...v1.3.0) (2026-05-02)


### Added

* **lib:** add flattenUsageLog helper ([cf3a48f](https://github.com/sftinc/openrouter-agent/commit/cf3a48f5a203db00ca113b8063628c8dc3cd6694))
* **loop:** record agent entries from subagent invocations and roll into Result.usage ([c6040b4](https://github.com/sftinc/openrouter-agent/commit/c6040b412fcd26d68793e13dd03d9476b9102e7f))
* **loop:** record embed entry generationId and clarify completion_tokens ([5eeb620](https://github.com/sftinc/openrouter-agent/commit/5eeb6206c9a021a92d96c5a9626bf443ecb79e9e))
* **loop:** record tool entries from deps.complete and roll into Result.usage ([8eb2011](https://github.com/sftinc/openrouter-agent/commit/8eb201168dbc11038ddd77235ec12a6ab5313a75))
* **loop:** record turn entries on usageLog ([1520382](https://github.com/sftinc/openrouter-agent/commit/15203824dd46630d6cc80ae78dd4aeaec12bb4d0))
* **tool:** add ToolDeps.embed with usage logging ([81e4452](https://github.com/sftinc/openrouter-agent/commit/81e4452068347a6f9da6bd4ccd544e195e21b7be))
* **types:** add Result.runId and Result.usageLog ([cbcdc5e](https://github.com/sftinc/openrouter-agent/commit/cbcdc5e3fed2330bb98ca6b5036601c3a1838720))
* **types:** add UsageLogSource and UsageLogEntry ([db94c08](https://github.com/sftinc/openrouter-agent/commit/db94c084ee4b657a53cc7f3bf508ea8aea4506e2))
* **types:** re-export UsageLogSource, UsageLogEntry, and flattenUsageLog from package root ([c4505e5](https://github.com/sftinc/openrouter-agent/commit/c4505e5ae918b6855567c3dabf9912ef9a51f913))


### Fixed

* **loop:** preserve partial usage on stream errors and harden embed against missing usage ([f9a4138](https://github.com/sftinc/openrouter-agent/commit/f9a41380e54525691a4bedae17801ec8947966ef))
* **usage:** stop aggregating is_byok in addUsage ([b633a80](https://github.com/sftinc/openrouter-agent/commit/b633a80355010da0111e2d56dcb745605187e257))


### Changed

* **openrouter:** type modality-specific prompt token fields on EmbedResponse ([e4bf355](https://github.com/sftinc/openrouter-agent/commit/e4bf3552ae2ad141dcac5d4a76d2b509be4d89f1))

## [1.2.2](https://github.com/sftinc/openrouter-agent/compare/v1.2.1...v1.2.2) (2026-05-01)


### Fixed

* **docs:** use new content field name in message:delta prose ([37ceb4d](https://github.com/sftinc/openrouter-agent/commit/37ceb4dadf086815bd01979fc8c4350ca418a24b))

## [1.2.1](https://github.com/sftinc/openrouter-agent/compare/v1.2.0...v1.2.1) (2026-05-01)


### Fixed

* **docs:** correct stale event field names and tool event types ([4baff6c](https://github.com/sftinc/openrouter-agent/commit/4baff6c1f937d59ce63eaf223115d64c995a9a85))

## [1.2.0](https://github.com/sftinc/openrouter-agent/compare/v1.1.2...v1.2.0) (2026-05-01)


### Added

* **openrouter:** add embedModel option to OpenRouterClient ([95c1220](https://github.com/sftinc/openrouter-agent/commit/95c1220d49af841c9d2a77f40eeb6c3237687cbb))
* **openrouter:** add EmbedRequest and EmbedResponse types ([72fa5a0](https://github.com/sftinc/openrouter-agent/commit/72fa5a09a514ba47c5f6226032ed565d727c6bb2))
* **openrouter:** add OpenRouterClient.embed() ([cae3762](https://github.com/sftinc/openrouter-agent/commit/cae376235ff860386bb6cad3c55ff8ab316cd30c))
* **openrouter:** connection-level retry on complete() at parity with completeStream ([3290efb](https://github.com/sftinc/openrouter-agent/commit/3290efbf675922daee1f3efa79c94a6b6e6d0f1a))
* **openrouter:** re-export RequestOptions, EmbedRequest, EmbedResponse ([8384435](https://github.com/sftinc/openrouter-agent/commit/8384435fe5de6a7a45b5b5457173fabf6235feb2))


### Changed

* **openrouter:** extract buildHeaders() shared by complete + completeStream ([acb5196](https://github.com/sftinc/openrouter-agent/commit/acb5196b6e9c1481fd37101261796905b4227df1))
* **openrouter:** rename CompleteStreamOptions to RequestOptions ([a8f1615](https://github.com/sftinc/openrouter-agent/commit/a8f161511f1b4168090f8c751e0161d17a428778))

## [1.1.2](https://github.com/sftinc/openrouter-agent/compare/v1.1.1...v1.1.2) (2026-05-01)


### Fixed

* handle parallel tool calls in deps.getMessages snapshot ([da6efb4](https://github.com/sftinc/openrouter-agent/commit/da6efb47ba12775a6704e7a2233c94df8db29de5))
* log error response body in completeStream non-2xx path ([83489d5](https://github.com/sftinc/openrouter-agent/commit/83489d5255c2f1fd81cab664362dfc9d7383cbd5))
* strip in-flight tool_use from deps.getMessages() snapshot ([9e5759a](https://github.com/sftinc/openrouter-agent/commit/9e5759a96f3a24c27b7c6e9418cd880292fe4ee8))

## [1.1.1](https://github.com/sftinc/openrouter-agent/compare/v1.1.0...v1.1.1) (2026-04-30)


### Changed

* rename message:delta.text to message:delta.content ([a378be9](https://github.com/sftinc/openrouter-agent/commit/a378be90b2cf60f596261261dbef1a4d7e9c5572))
* rename Result.text to Result.content ([e167c51](https://github.com/sftinc/openrouter-agent/commit/e167c5126386d3def02155ab39bf9eab8480fb8e))
* rename tool:end.output to tool:end.content ([db613da](https://github.com/sftinc/openrouter-agent/commit/db613daa88a8a373bfd684a7be1a1f15a9066781))
* update missed Result fixture in consumeEvents.test.ts ([69cde96](https://github.com/sftinc/openrouter-agent/commit/69cde96e7f50477e6dd4ce4e54dc2fea99c961c2))
* update missed Result fixture in responseAdapters.test.ts ([ba12435](https://github.com/sftinc/openrouter-agent/commit/ba1243569460b972cf559174ea657a78c9ae8070))

## [1.1.0](https://github.com/sftinc/openrouter-agent/compare/v1.0.2...v1.1.0) (2026-04-29)


### Added

* **package:** ship docs/api and runnable examples to consumers ([dac0f8b](https://github.com/sftinc/openrouter-agent/commit/dac0f8b74bc52be3a693cc332b7bd3508a4f4fd0))

## [1.0.2](https://github.com/sftinc/openrouter-agent/compare/v1.0.1...v1.0.2) (2026-04-29)

## [1.0.1](https://github.com/sftinc/openrouter-agent/compare/v1.0.0...v1.0.1) (2026-04-29)


### Fixed

* **package:** add repository, homepage, and bugs metadata ([da18011](https://github.com/sftinc/openrouter-agent/commit/da180110f50e3012d1b44cb3dee6a19637534fd9))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
