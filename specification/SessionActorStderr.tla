------------------------- MODULE SessionActorStderr -------------------------
EXTENDS Naturals, Integers, Sequences, TLC
CONSTANT Fault
Cap == 4
A == 0
Euro == 1
Emoji == 2
Replacement == 3
Bytes(c) == CASE c=A -> 1 [] c=Euro -> 3 [] c=Emoji -> 4 [] OTHER -> 3
Units(c) == IF c=Emoji THEN 2 ELSE 1
RECURSIVE ByteSize(_), UnitSize(_), Truncate(_, _)
ByteSize(s) == IF s = <<>> THEN 0 ELSE Bytes(Head(s))+ByteSize(Tail(s))
UnitSize(s) == IF s = <<>> THEN 0 ELSE Units(Head(s))+UnitSize(Tail(s))
\* Buffer UTF-8 prefix decoding replaces a cut scalar; the stored cap may overshoot.
Truncate(s,n) == IF s = <<>> \/ n<=0 THEN <<>> ELSE
  IF Bytes(Head(s))<=n THEN <<Head(s)>> \o Truncate(Tail(s),n-Bytes(Head(s)))
  ELSE <<Replacement>>
Chunks == {<<A>>,<<Euro>>,<<Emoji>>,<<A,A,A>>,<<A,A,A,A>>}
Modes == {"Native","SizeThrow","SizeZero","MaxThrow","MaxOne"}
Guard(p) == CASE Fault="Early" -> UnitSize(p)>=Cap-1
              [] Fault="Late" -> UnitSize(p)>Cap
              [] OTHER -> UnitSize(p)>=Cap
Outcome(p,c,mode,candidate) ==
  IF candidate /\ Guard(p) THEN [prefix |-> p,error |-> "",sizing |-> 0,maximum |-> 0,append |-> 0]
  ELSE IF mode="SizeThrow" THEN [prefix |-> p,error |-> "size",sizing |-> 1,maximum |-> 0,append |-> 0]
  ELSE LET observed == IF mode="SizeZero" THEN 0 ELSE
                          IF candidate /\ Fault="Units" THEN UnitSize(p) ELSE ByteSize(p)
           available == IF mode="MaxOne" THEN 1 ELSE IF Cap-observed>0 THEN Cap-observed ELSE 0
       IN IF mode="MaxThrow" THEN [prefix |-> p,error |-> "max",sizing |-> 1,maximum |-> 1,append |-> 0]
          ELSE [prefix |-> p \o Truncate(c,available),error |-> "",sizing |-> 1,maximum |-> 1,
                append |-> IF available>0 THEN 1 ELSE 0]
VARIABLES prefix, depth, observation
vars == <<prefix,depth,observation>>
Pair(p,c,m) == [eligible |-> UnitSize(p)>=Cap, mode |-> m,
                original |-> Outcome(p,c,m,FALSE), guarded |-> Outcome(p,c,m,TRUE)]
Init == /\ prefix = <<>> /\ depth=0 /\ observation=Pair(<<>>,<<A>>,"Native")
\* Only native accumulation advances state. Intrinsic probes compare one callback
\* from the same current state; root accepts divergence at the eligible site.
NativeStep ==
  /\ depth<3
  /\ \E c \in Chunks:
       /\ observation'=Pair(prefix,c,"Native")
       /\ prefix'=Outcome(prefix,c,"Native",FALSE).prefix
       /\ depth'=depth+1
Probe == /\ \E c \in Chunks,m \in Modes: observation'=Pair(prefix,c,m)
         /\ UNCHANGED <<prefix,depth>>
Next == NativeStep \/ Probe
SameResult(o) == o.original.prefix=o.guarded.prefix /\ o.original.error=o.guarded.error
NativeParity == observation.mode="Native" => SameResult(observation)
FallbackParity == ~observation.eligible => observation.original=observation.guarded
EligibleWork == observation.eligible => /\ observation.guarded.sizing=0
                                        /\ observation.guarded.maximum=0
                                        /\ observation.guarded.append=0
NativeBounds == ByteSize(prefix)>=UnitSize(prefix) /\ ByteSize(prefix)<=Cap+2
Spec == Init /\ [][Next]_vars
=============================================================================
