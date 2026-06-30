# Changelog

## [1.2.2](https://github.com/pugliatechs/polpo/compare/v1.2.1...v1.2.2) (2026-06-30)


### Features

* **gateway:** optional model override on POST /v1/tasks ([f424c34](https://github.com/pugliatechs/polpo/commit/f424c34aeb3c2ce78889d65e932a3e15debd9fd8))
* **mind,web:** inline action buttons for plan approval + arm escalation ([a085792](https://github.com/pugliatechs/polpo/commit/a0857920f8fd7e2cc7d5ee4fa35de47243832c08))
* **mind:** interactive plan approval + escalation on blocker ([ea4de1e](https://github.com/pugliatechs/polpo/commit/ea4de1ebf4de7919e9caffa0a7a8b5446d53b24c))
* **server,web:** mobile setup QR codes for trust-localhost dashboards ([b367fa9](https://github.com/pugliatechs/polpo/commit/b367fa929d8d61c34f8164e7ca0289039acb54a0))
* **server,web:** paginate + cache /api/sessions; "View all" modal replaces infinite scroll ([12d2e1d](https://github.com/pugliatechs/polpo/commit/12d2e1d973a9d2fa9ed46233e9852c01846f59e0))


### Bug Fixes

* **mind:** watcher only alerts on mind-owned arms, not user sessions ([bc5b9e3](https://github.com/pugliatechs/polpo/commit/bc5b9e34975873879227802f3e0c135a21b174aa))


### Miscellaneous Chores

* drop hand-written release notes file; CI generates them ([fa103b2](https://github.com/pugliatechs/polpo/commit/fa103b2855f0e23310b15574cdfd8fa16fcada6f))

## [1.2.1](https://github.com/pugliatechs/polpo/compare/v1.2.0...v1.2.1) (2026-06-20)


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

### Refactoring

* **agent,mind:** extract OneShotAgentRunner; unify gateway + mind spawn lifecycle ([d75b49c](https://github.com/pugliatechs/polpo/commit/d75b49c))
* **util:** route all server/mind/agent/hooks/tunnel logs through makeLogger ([0000b91](https://github.com/pugliatechs/polpo/commit/0000b91))

### Documentation

* v1.2.1 documentation pass — one-shot architecture, outbox, gateway, agent-facing guide ([fc48644](https://github.com/pugliatechs/polpo/commit/fc48644))

### Miscellaneous Chores

* pin release to 1.2.1 ([173b58e](https://github.com/pugliatechs/polpo/commit/173b58e122255f6244f83ceb5364924251ce1aa6))

## [1.2.0](https://github.com/pugliatechs/polpo/compare/v1.1.9...v1.2.0) (2026-05-14)


### Features

* Bidirectional file transfer for the /v1 gateway ([137c54a](https://github.com/pugliatechs/polpo/commit/137c54ad4b04632e14173ab21743f58296135c3b))
* Programmatic /v1 gateway for remote agent execution ([8ac2898](https://github.com/pugliatechs/polpo/commit/8ac2898c3239635f1448a76060c04fe56d9248d7))


### Bug Fixes

* Skip dashboard static-auth for /v1 gateway paths ([c108f0a](https://github.com/pugliatechs/polpo/commit/c108f0a9378b37d1855e49787fbe69f9f7312da0))
