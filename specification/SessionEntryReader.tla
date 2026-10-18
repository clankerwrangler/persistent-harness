-------------------- MODULE SessionEntryReader --------------------
EXTENDS Naturals, Sequences, TLC
CONSTANTS Fault, MaxMutations
VARIABLES mode, count, owner, generation, value, pending, bytesOK, mutations,
          capturedCount, capturedOwner, capturedGeneration, capturedValue, successor,
          headerKey, reading, readIndex, expected, payload,
          badIO, badPublication, fullResult, fullExpected,
          syncCount, syncFailed, badWork
vars == <<mode,count,owner,generation,value,pending,bytesOK,mutations,
          capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
          headerKey,reading,readIndex,expected,payload,
          badIO,badPublication,fullResult,fullExpected,syncCount,syncFailed,badWork>>
CurrentKey(i) == IF i=1 THEN value ELSE 1
CapturedKey(i) == IF i=1 THEN capturedValue ELSE 1
ReaderKey(i) == IF mode="default" THEN CapturedKey(i) ELSE CurrentKey(i)
OwnerOK == mode="default" \/ owner=capturedOwner
GenerationOK == generation=capturedGeneration
BoundsOK(i) == i \in 1..capturedCount
KeyOK(i,k) == k # 0 /\ k=ReaderKey(i)
ExactPre(i,k) == OwnerOK /\ GenerationOK /\ BoundsOK(i) /\ KeyOK(i,k)
Pre(i,k) == /\ (Fault="owner" \/ OwnerOK)
            /\ (Fault="generation" \/ GenerationOK)
            /\ (IF Fault="bounds" THEN i \in 1..count ELSE BoundsOK(i))
            /\ (Fault="pre-key" \/ KeyOK(i,k))
ExactPost == ExactPre(readIndex,expected) /\ (mode="default" \/ bytesOK)
Post == /\ (Fault="owner" \/ OwnerOK) /\ (Fault="generation" \/ GenerationOK)
        /\ BoundsOK(readIndex) /\ (Fault="post-key" \/ KeyOK(readIndex,expected))
        /\ (Fault="bytes" \/ mode="default" \/ bytesOK)
Init == /\ mode \in {"bounded","default"} /\ count=1 /\ owner=0 /\ generation=0
        /\ value=1 /\ pending=TRUE /\ bytesOK=TRUE /\ mutations=0
        /\ capturedCount=1 /\ capturedOwner=0 /\ capturedGeneration=0 /\ capturedValue=1
        /\ successor=FALSE /\ headerKey=0 /\ reading=FALSE /\ readIndex=0 /\ expected=0 /\ payload=0
        /\ badIO=FALSE /\ badPublication=FALSE /\ fullResult=0 /\ fullExpected=0
        /\ syncCount=1 /\ syncFailed=FALSE /\ badWork=FALSE
Mutation(kind) ==
  /\ mutations < MaxMutations
  /\ CASE kind="append" -> count=1
       [] kind="redirect" -> value=1
       [] kind="owner" -> owner=0
       [] kind="reload" -> generation=0
       [] kind="bytes" -> bytesOK
       [] kind="persist" -> pending
  /\ count'=IF kind="append" THEN 2 ELSE count
  /\ owner'=IF kind="owner" THEN 1 ELSE owner
  /\ generation'=IF kind="reload" THEN 1 ELSE generation
  /\ value'=IF kind="redirect" THEN 2 ELSE value
  /\ bytesOK'=IF kind="bytes" THEN FALSE ELSE bytesOK
  /\ pending'=IF kind="persist" THEN FALSE ELSE pending
  /\ mutations'=mutations+1
  /\ UNCHANGED <<mode,capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 headerKey,reading,readIndex,expected,payload,badIO,badPublication,
                 fullResult,fullExpected,syncCount,syncFailed,badWork>>
CaptureSuccessor ==
  /\ ~successor /\ ~reading
  /\ capturedCount'=count /\ capturedOwner'=owner /\ capturedGeneration'=generation /\ capturedValue'=value
  /\ successor'=TRUE /\ headerKey'=0
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 reading,readIndex,expected,payload,badIO,badPublication,
                 fullResult,fullExpected,syncCount,syncFailed,badWork>>
Header(i) ==
  /\ ~reading /\ OwnerOK /\ GenerationOK /\ BoundsOK(i)
  /\ headerKey'=ReaderKey(i)
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 reading,readIndex,expected,payload,badIO,badPublication,
                 fullResult,fullExpected,syncCount,syncFailed,badWork>>
BeginRead(i,k) ==
  /\ ~reading /\ Pre(i,k)
  /\ reading'=TRUE /\ readIndex'=i /\ expected'=k
  /\ payload'=IF mode="default" /\ Fault # "default-capture" THEN CapturedKey(i) ELSE CurrentKey(i)
  /\ badIO'=(badIO \/ ~ExactPre(i,k))
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 headerKey,badPublication,fullResult,fullExpected,syncCount,syncFailed,badWork>>
FinishRead ==
  /\ reading /\ reading'=FALSE
  /\ badPublication'=(badPublication \/ (Post /\ (~ExactPost \/ payload # expected)))
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 headerKey,readIndex,expected,payload,badIO,fullResult,fullExpected,
                 syncCount,syncFailed,badWork>>
\* Existing full capture owns its copied old location/value. A same-generation
\* redirect changes only the live indexed key; it does not replace that copy.
FullSourceRead ==
  /\ GenerationOK /\ (mode="default" \/ bytesOK)
  /\ fullResult'=capturedValue /\ fullExpected'=capturedValue
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 headerKey,reading,readIndex,expected,payload,badIO,badPublication,
                 syncCount,syncFailed,badWork>>
Sync(complete) ==
  /\ count>syncCount /\ ~syncFailed
  /\ badWork'=(badWork \/ (complete /\ (IF Fault="eager-headers" THEN count ELSE count-syncCount) # count-syncCount))
  /\ syncFailed'=~complete
  /\ syncCount'=IF complete \/ Fault="partial-publish" THEN count ELSE 0
  /\ UNCHANGED <<mode,count,owner,generation,value,pending,bytesOK,mutations,
                 capturedCount,capturedOwner,capturedGeneration,capturedValue,successor,
                 headerKey,reading,readIndex,expected,payload,badIO,badPublication,fullResult,fullExpected>>
Next == (\E kind \in {"append","redirect","owner","reload","bytes","persist"}: Mutation(kind))
        \/ CaptureSuccessor \/ (\E i \in 1..2: Header(i))
        \/ (\E i \in 0..3, k \in {0,1,2}: BeginRead(i,k)) \/ FinishRead \/ FullSourceRead
        \/ (\E complete \in BOOLEAN: Sync(complete))
Spec == Init /\ [][Next]_vars
NoInvalidPayloadIO == ~badIO
KeyedPublication == ~badPublication
ExistingFullCapture == fullResult=fullExpected
NoPartialPublication == syncFailed => syncCount=0
SuffixHeadersOnly == ~badWork
TypeOK == /\ count \in 1..2 /\ capturedCount \in 1..2 /\ mutations \in 0..MaxMutations
          /\ value \in 1..2 /\ capturedValue \in 1..2
=============================================================================
