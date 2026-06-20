# Changelog

## [1.3.0](https://github.com/pugliatechs/polpo/compare/v1.2.0...v1.3.0) (2026-06-20)


### Features

* **gateway:** session discovery + Builder Profile + goals SSE + client-label fallback ([ef90420](https://github.com/pugliatechs/polpo/commit/ef904204973e5af7f3998b079aa459a3a284bffb))
* **profile:** Builder Profile — local activity analyzer + CLI ([d39d9ca](https://github.com/pugliatechs/polpo/commit/d39d9ca8c9426a904cb3e7d8bd792a01a0a98fab))
* **server:** per-instance message seq + clientMsgId pass-through ([309be25](https://github.com/pugliatechs/polpo/commit/309be25616fa1837b997d8c6fad0d8da25320eff))
* **server:** session outbox — agent → phone file transfer for dashboard sessions ([bdbb5f3](https://github.com/pugliatechs/polpo/commit/bdbb5f3e213137f91a4f145cc6ac902f5bd63649))
* **util:** shared timestamped logger + microsecond-precision log prefix ([02b9d73](https://github.com/pugliatechs/polpo/commit/02b9d732c1afa5cdf9eb8cf25a4ee540fd85db4f))
* **web:** v1.2.1 frontend bundle — outbox UI, optimistic prompts, model picker, Builder Profile card, mind arm grouping ([5c92ed4](https://github.com/pugliatechs/polpo/commit/5c92ed48b607e70cea5d340cca853481fa2d9d90))


### Bug Fixes

* **sessions:** preserve plain-string user prompts in history loader ([979cffc](https://github.com/pugliatechs/polpo/commit/979cffcfde24e4f2d34da14c99fa5e72d5f2af4b))
* **tunnel:** require multi-segment subdomain for Cloudflare Quick Tunnel URL ([cac0dcb](https://github.com/pugliatechs/polpo/commit/cac0dcb419d30fc4f49ebd60b6b7277de94727e0))

## [1.2.0](https://github.com/pugliatechs/polpo/compare/v1.1.9...v1.2.0) (2026-05-14)


### Features

* Bidirectional file transfer for the /v1 gateway ([137c54a](https://github.com/pugliatechs/polpo/commit/137c54ad4b04632e14173ab21743f58296135c3b))
* Programmatic /v1 gateway for remote agent execution ([8ac2898](https://github.com/pugliatechs/polpo/commit/8ac2898c3239635f1448a76060c04fe56d9248d7))


### Bug Fixes

* Skip dashboard static-auth for /v1 gateway paths ([c108f0a](https://github.com/pugliatechs/polpo/commit/c108f0a9378b37d1855e49787fbe69f9f7312da0))
