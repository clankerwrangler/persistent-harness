---------------- MODULE FirstInputSnapshot ----------------
EXTENDS Integers, Sequences, FiniteSets
CONSTANT StaleInitial
VARIABLES queue, delivered, rev, sent, snapshots, active, flight, accepted, prepared, promptInput, preparedInput, requestPrompts
vars == <<queue, delivered, rev, sent, snapshots, active, flight, accepted, prepared, promptInput, preparedInput, requestPrompts>>
Inputs == {"auto", "follow"}
Init == /\ queue = <<>> /\ delivered = <<>> /\ rev = 0 /\ sent = IF StaleInitial THEN -1 ELSE 0
        /\ snapshots = <<>> /\ active = FALSE /\ flight = FALSE /\ accepted = {}
        /\ prepared = FALSE /\ promptInput = "none" /\ preparedInput = "none" /\ requestPrompts = <<>>
Accept(i) == /\ i \in Inputs /\ i \notin accepted /\ queue' = Append(queue,i)
             /\ accepted' = accepted \cup {i} /\ UNCHANGED <<delivered,rev,sent,snapshots,active,flight,prepared,promptInput,preparedInput,requestPrompts>>
Begin == /\ ~active /\ Len(queue)>0 /\ active'=TRUE
         /\ UNCHANGED <<queue,delivered,rev,sent,snapshots,flight,accepted,prepared,promptInput,preparedInput,requestPrompts>>
Deliver == /\ active /\ ~flight /\ Len(queue)>0
           /\ (Head(queue)="auto" \/ rev=sent)
           /\ delivered'=Append(delivered,Head(queue)) /\ queue'=Tail(queue) /\ rev'=rev+1
           /\ promptInput'=Head(queue) /\ prepared'=FALSE
           /\ UNCHANGED <<sent,snapshots,active,flight,accepted,preparedInput,requestPrompts>>
PreparePrompt == /\ active /\ ~flight /\ rev>sent /\ ~prepared
                 /\ prepared'=TRUE /\ preparedInput'=promptInput
                 /\ UNCHANGED <<queue,delivered,rev,sent,snapshots,active,flight,accepted,promptInput,requestPrompts>>
Infer == /\ active /\ ~flight /\ rev>sent /\ Len(snapshots)<2 /\ prepared
         /\ ~(Len(queue)>0 /\ Head(queue)="auto")
         /\ snapshots'=Append(snapshots,delivered) /\ sent'=rev /\ flight'=TRUE
         /\ requestPrompts'=Append(requestPrompts,preparedInput)
         /\ UNCHANGED <<queue,delivered,rev,active,accepted,prepared,promptInput,preparedInput>>
End == /\ flight /\ flight'=FALSE /\ UNCHANGED <<queue,delivered,rev,sent,snapshots,active,accepted,prepared,promptInput,preparedInput,requestPrompts>>
Settle == /\ active /\ ~flight /\ Len(queue)=0 /\ rev=sent /\ active'=FALSE
          /\ UNCHANGED <<queue,delivered,rev,sent,snapshots,flight,accepted,prepared,promptInput,preparedInput,requestPrompts>>
Next == Begin \/ Deliver \/ PreparePrompt \/ Infer \/ End \/ Settle \/ (\E i \in Inputs: Accept(i))
TypeOK == /\ queue \in Seq(Inputs) /\ delivered \in Seq(Inputs) /\ rev \in 0..2
          /\ sent \in -1..2 /\ active \in BOOLEAN /\ flight \in BOOLEAN
          /\ accepted \subseteq Inputs /\ Len(snapshots)<=2
NoEmptySnapshot == \A j \in 1..Len(snapshots): Len(snapshots[j])>0
OnlyDeliveredInput == \A j \in 1..Len(snapshots): \A i \in 1..Len(snapshots[j]): snapshots[j][i] \in accepted
DeliveryRevision == rev=Len(delivered)
\* Prompt rendering includes the latest extension options and owner preparation.
PromptMatchesLatestInput == \A j \in 1..Len(snapshots):
    Len(snapshots[j])>0 => requestPrompts[j]=snapshots[j][Len(snapshots[j])]
NoStalePreparedPrompt == prepared => preparedInput=promptInput
Spec == Init /\ [][Next]_vars
============================================================
