# Skill artifact generation pins

`SkillArtifactPins.tla` models two source/artifact versions, two actors, and two worker generations per actor. Desired grants can reconcile while capture, preparation, or startup is paused. A generation loads its create-only grant snapshot, while saved manifests and retained generation snapshots keep old artifacts referenced. Source and materialized identities remain separate even when the legacy source hash is unchanged.

From `specification/`, run the positive configuration with a disposable state directory:

```sh
java -Xmx64m -XX:ActiveProcessorCount=1 -cp /opt/tla/tla2tools-1.7.4.jar tlc2.TLC -workers 1 -metadir /tmp/skill-artifact-pins-positive -config SkillArtifactPins.cfg SkillArtifactPins.tla
```

Run the same command with each negative configuration and a separate state directory. Both intentionally violate an invariant and must fail:

- `SkillArtifactPins.bad-current-desired.cfg`: startup reads the latest desired grant instead of the admitted generation snapshot; violates `GenerationReadsPinned`.
- `SkillArtifactPins.bad-reconciled-snapshot.cfg`: a paused preparation publishes newly reconciled desired bytes instead of the generation's exact admitted bytes; violates `GrantSnapshotPinned`.

The finite model assumes trusted filesystem/sidecar owners and atomic, coherent publication. It does not model hostile same-UID writers or filesystem durability after power loss. Artifact identity/digest and local POSIX metadata checks are implementation boundaries verified separately. Private directory permissions are not a same-UID isolation boundary. No artifact collector is enabled; `Collect` records the minimum reference guards for any future maintenance owner.
