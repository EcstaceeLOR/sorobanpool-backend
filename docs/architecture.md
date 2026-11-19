# Architecture
See the build brief sections 4 and 7. The backend cannot move escrowed funds; contracts are the source of truth.

## Decisions
- [0009 Refunds are pull-first, with keeper pushes as the backstop](decisions/0009-refund-push-vs-pull.md): `claim_refund` for members, `push_refunds` in batches of 25 from the keeper.
