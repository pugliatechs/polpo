# Changelog

## [1.2.3](https://github.com/pugliatechs/polpo/compare/v1.2.2...v1.2.3) (2026-09-24)


### Features

* **gateway:** let external agents follow up on a goal or ask about its result ([42c7696](https://github.com/pugliatechs/polpo/commit/42c7696a0c75053773f30fe536ae2ee0afa36905))
* **mind:** answer a blocked arm instead of killing and replacing it ([58d70ad](https://github.com/pugliatechs/polpo/commit/58d70ad194e5f6ac797db7f2312ca2ace8b55750))
* **mind:** make guardrail refusals visible instead of silent ([31e292d](https://github.com/pugliatechs/polpo/commit/31e292d81302be35fb3719e2081e2339cc3c6a0e))
* **mind:** show a goal's result, and let the user follow up on it or ask about it ([da7b8d1](https://github.com/pugliatechs/polpo/commit/da7b8d1ba6dc324fc82befb83495da5694910168))
* **tunnel:** supervise the tunnel and announce rotated URLs ([870ddb5](https://github.com/pugliatechs/polpo/commit/870ddb5d6c4fd5eb47d95b3cce711cb7c9eae232))
* **web:** group gateway tasks in their own sidebar section ([d2ded19](https://github.com/pugliatechs/polpo/commit/d2ded198fc1ee02c88391ca1012ca3a91b89885e))


### Bug Fixes

* **agent:** send the origin tag at registration, and label the live sessions ([563b2dc](https://github.com/pugliatechs/polpo/commit/563b2dc55402a37da6c781c313182c50680c99b4))
* **codex:** stop passing flags that codex exec no longer accepts ([58695b9](https://github.com/pugliatechs/polpo/commit/58695b946a2611398c33d2642928381247846c1b))
* **gateway:** give external callers the result of a goal ([1aab995](https://github.com/pugliatechs/polpo/commit/1aab99597e8f61fe53dae2ade5c22d10a620db8b))
* **mind:** give the mind back the output of its own arms ([302688c](https://github.com/pugliatechs/polpo/commit/302688cfe8b1759459a84d6fcec551d83ef578c6))
* **mind:** stop writing prompt text into the verbose agent log ([848bb93](https://github.com/pugliatechs/polpo/commit/848bb939cb89745f99d82d0f45051c21a370c074))
* **mind:** the dispatch line printed the task description twice ([7b4dd90](https://github.com/pugliatechs/polpo/commit/7b4dd90f0ac96d4f36f7f9268a1e6a1d31030ca0))
* **sessions:** resume a session from the directory it was created in ([63980e3](https://github.com/pugliatechs/polpo/commit/63980e3743998afcba30ca8a735ea1b09890dea2))
* **tunnel:** say why a tunnel failed, and keep retrying one that fails at startup ([a5cce6c](https://github.com/pugliatechs/polpo/commit/a5cce6c9dc63b5a0a3540c5ec9bb06e0a08157e2))
* **web:** inline action buttons did nothing, and attribute escaping was unsafe ([f273e8f](https://github.com/pugliatechs/polpo/commit/f273e8ffb480f16255279090b5c57c50d8e11c34))
* **web:** show the Builder Profile from page load instead of tens of seconds later ([225ce7a](https://github.com/pugliatechs/polpo/commit/225ce7a2f3fd49f3c99c9455114f505c08337236))
* **web:** the Builder Profile explainer opened off-screen and could not be closed ([cec80dd](https://github.com/pugliatechs/polpo/commit/cec80ddf35cc368fa61de4999ccb7b93651f3e52))
* **web:** version display goes empty / stale after polpo release ([72c9805](https://github.com/pugliatechs/polpo/commit/72c9805b609494e54988a023e48967a09e9df74c))


### Miscellaneous Chores

* release 1.2.3 ([736a6d7](https://github.com/pugliatechs/polpo/commit/736a6d7f3e2472fd4e045b7b5fe59e9e3db436bb))

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
