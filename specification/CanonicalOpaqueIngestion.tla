-------------------- MODULE CanonicalOpaqueIngestion --------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS BadEagerOpaque, BadMetadata, BadValue, BadFence
VARIABLES revision, generation, count, leaf, changes, metadataValid, nativeValid,
          opaqueValid, draft, published, source, opaqueReads, requested, exposed,
          consumedNative, readStamp, publicationStamp
vars == <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
          opaqueValid, draft, published, source, opaqueReads, requested, exposed,
          consumedNative, readStamp, publicationStamp>>
Empty == [revision |-> 99, generation |-> 99, count |-> 0, leaf |-> 0, valid |-> FALSE]
Current == [revision |-> revision, generation |-> generation, count |-> count, leaf |-> leaf,
            valid |-> metadataValid /\ nativeValid]
Same(s) == s.revision = revision /\ s.generation = generation /\ s.count = count /\ s.leaf = leaf
Init == /\ revision = 0 /\ generation = 0 /\ count = 1 /\ leaf = 1 /\ changes = 0
        /\ metadataValid \in BOOLEAN /\ nativeValid \in BOOLEAN /\ opaqueValid \in BOOLEAN
        /\ draft = Empty /\ published = Empty /\ source = Empty /\ readStamp = Empty /\ publicationStamp = Empty
        /\ opaqueReads = FALSE /\ requested = FALSE /\ exposed = FALSE /\ consumedNative = FALSE
\* Discovery validates the complete ID/parent inventory, but unrelated custom
\* payload values do not contribute to birth, recovery, or ordinary model context.
Discover == /\ draft' = [Current EXCEPT !.valid = (metadataValid \/ BadMetadata) /\ nativeValid]
            /\ opaqueReads' = (opaqueReads \/ BadEagerOpaque)
            /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                            opaqueValid, published, source, requested, exposed, consumedNative, readStamp, publicationStamp>>
\* Publication requires all selected semantic facts and the captured source,
\* leaf, and suffix extent to remain current. Failed validation publishes nothing.
Publish == /\ draft.valid /\ (Same(draft) \/ BadFence)
           /\ published' = draft /\ source' = draft /\ publicationStamp' = Current
           /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                           opaqueValid, draft, opaqueReads, requested, exposed, consumedNative, readStamp>>
OrdinaryRequest == /\ Same(published) /\ published.valid
                  /\ consumedNative' = nativeValid /\ opaqueReads' = (opaqueReads \/ BadEagerOpaque)
                  /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                                  opaqueValid, draft, published, source, requested, exposed, readStamp, publicationStamp>>
Bookkeeping == /\ Same(published) /\ published.valid
               /\ opaqueReads' = (opaqueReads \/ BadEagerOpaque)
               /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                               opaqueValid, draft, published, source, requested, exposed, consumedNative, readStamp, publicationStamp>>
RequestOpaque == /\ Same(published) /\ published.valid
                 /\ requested' = TRUE /\ readStamp' = source
                 /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                                 opaqueValid, draft, published, source, opaqueReads, exposed, consumedNative, publicationStamp>>
\* Full-value APIs consume and validate the requested body. Borrowed sources
\* expire across rewrite/reload; an independently captured value is not a source.
ReadOpaque == /\ requested /\ (readStamp.generation = generation \/ BadFence)
              /\ opaqueReads' = TRUE /\ exposed' = (opaqueValid \/ BadValue)
              /\ UNCHANGED <<revision, generation, count, leaf, changes, metadataValid, nativeValid,
                              opaqueValid, draft, published, source, requested, consumedNative, readStamp, publicationStamp>>
Change == /\ changes < 2 /\ changes' = changes + 1 /\ revision' = revision + 1
          /\ generation' \in {generation, generation + 1} /\ count' \in 1..2 /\ leaf' \in 0..count'
          /\ metadataValid' \in BOOLEAN /\ nativeValid' \in BOOLEAN
          /\ consumedNative' = FALSE /\ exposed' = FALSE
          /\ UNCHANGED <<opaqueValid, draft, published, source, opaqueReads, requested, readStamp, publicationStamp>>
Next == Discover \/ Publish \/ OrdinaryRequest \/ Bookkeeping \/ RequestOpaque \/ ReadOpaque \/ Change
Spec == Init /\ [][Next]_vars
NoEagerOpaque == opaqueReads => requested
MetadataGate == Same(published) /\ published.valid => metadataValid
SelectedNativeGate == Same(published) /\ published.valid => nativeValid
ValueValidation == exposed => opaqueValid
ReadFence == exposed => readStamp.generation = generation
PublicationFence == published.valid => /\ published.revision = publicationStamp.revision
                                           /\ published.generation = publicationStamp.generation
                                           /\ published.count = publicationStamp.count
                                           /\ published.leaf = publicationStamp.leaf
TypeOK == /\ revision \in 0..2 /\ generation \in 0..2 /\ count \in 1..2 /\ leaf \in 0..2
          /\ changes \in 0..2 /\ opaqueReads \in BOOLEAN /\ requested \in BOOLEAN /\ exposed \in BOOLEAN
=============================================================================
