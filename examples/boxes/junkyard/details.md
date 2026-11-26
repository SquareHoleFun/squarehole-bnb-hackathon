# How the Junkyard works

## What is in the box

The coin is $TRASH. Gold means PAXG, a token linked to gold, not loose metal in a drawer.
The box pairs $TRASH with PAXG. The shop itself uses $TRASH for both gives and picks.
It holds NFTs from many listed collections. An NFT is a digital collectible.
The technical shop type is `BoxTypeV2.SHOP`, with `ShopVaultV2` holding the items.

## Giving and picking

Giving means sending an accepted NFT into the shop and getting $TRASH from its budget.
It is a sale to the shop, not a gift and not a loan.
The Junkyard Safe chooses one fixed give tier in $TRASH when it lists each collection.
That tier stays fixed. Changes in the gold market do not change it or pause the shop.

Picking means choosing a named NFT that is in the shop and paying $TRASH to take it out.
A pick costs 2x that collection's give amount.
The payment goes into the shop budget. Gives spend from that budget.
The budget holds only $TRASH, called T in the design notes.
The seed, pick receipts and the sellers' fees feed it. The Safe cannot take the seed back out.
The last item stays in the shop. A give does not reserve that same item for you later.

## Fees into the shop

Fees fill the shop up to a ceiling, then go to holders.
This is the sellers' side of the fee. The buyers' side always goes to holders in gold.
The ceiling is 2x the seed. It is fixed when the box is created, and nobody can change it.
Fees count toward the ceiling. Pick receipts can take the budget above it, and they stay in the shop.

The shop takes only what it wants. Before graduation, the sellers' 10/15 of each fee waits in gold.
After graduation, anyone can run the shop's fee step. Square Hole's keeper is built to run it.
The step buys $TRASH in the box's own pool and adds it to the budget, never past the ceiling.
Each step is small, and at most one pool step runs in a block.
Gold the shop does not want goes to holders. That includes gold that waited from before graduation.
An amount too small for one step goes to holders too, even while the shop is below its ceiling.
Once the shop is full, the sellers' 10/15 goes to holders in gold.
Whether fees go to the shop or to holders is decided when they are collected, not when the trade happens.

The warning for every shop box: whoever picks the collections decides who can sell into a budget the fees pay for.
In the Junkyard, the Safe picks the collections.

## A little room each week

The normal total give limit is 10% of the weekly budget snapshot.
The normal limit for one collection is 2.5% of that same snapshot.
A new list entry must wait 7 days before its NFTs can be given.

Both weekly limits have a floor of one cheapest active give, if the snapshot can cover it.
This floor can be larger than the normal percentage limit.
It is room shared across the week, not a new allowance for each visit.
A costlier give can still be too large. The actual budget must cover every give.

Weeks count from graduation.
The first give or pick of the week, or the first fee step that adds $TRASH, fixes the snapshot before it moves coins.
Pick receipts and fee $TRASH added after it help fund the next week.
Earlier spending still counts. Unused room does not carry into the next week.
The weekly give limits do not cap picks. The last-item rule still does.

## What a holder gets

A holder can have a share of trade fees paid in gold.
Holding $TRASH does not promise a payment or a fixed amount.
Shares depend on eligible holdings when the trade happens and on what is funded.
Later buyers do not get an earlier holder's recorded share.

The Junkyard recipe sends 10/15 of the buyers' fee to holders.
The buyers' side passes its gold through as paid.
The sellers' 10/15 goes to holders whenever the shop does not want it, as the section on fees explains.
This is a share of the fee, not a share of the whole trade.
The other 5/15 of each fee go to the box's own pool and to Square Hole (its platform and its buy-back).
They never feed the shop budget.
These are token-trade fees. They are separate from the shop's give and pick amounts.

Claims are claim-only. Each holder asks for their own funded gold share.
There is no automatic payment, claim minimum or claim tip.
Network costs can still apply. A blocked gold transfer can leave a claim waiting.
A sellers' share for holders can wait until the fee step settles that batch.
Owning an NFT from the shelf does not itself give a $TRASH holder share.

## The Junkyard Safe

The creator and curator are the Junkyard Safe, a wallet controlled by several signers.
It holds the creator buy, sized at 0.3 ETH-equivalent. For Sepolia, the founder must re-quote it after the native raise changes to 0.1 ETH, and pass the new raw price-coin amount as `creatorBuy` to the settings writer.
Those coins are the Safe's holding, separate from the shop budget.
The Safe funds the seed and starter set itself.

It sets a 30-day opening deadline at creation. That setting cannot be changed later.
This is the time allowed for the box to fill, not the life of the shop after it opens.
Collections that graduate on Square Hole need the same listing step as any other collection.
The Safe lists them; graduation does not add them by itself.

The Safe registers for holder payouts and gets its share like any other holder.
Its holder share has no cap.

## Risks in plain words

- $TRASH can lose all its value. A shelf full of items does not set a minimum value for the coin.
- PAXG has an issuer. It can freeze, wipe, burn or pause tokens and can charge a transfer fee.
- The local chain uses a PAXG-like test token. Its issuer can freeze, pause and switch on a fee.
- A gold token is not a promise that you can claim physical gold here. Its issuer and markets can fail.
- A collection can have unsafe code. Its issuer may create more items, seize them or stop transfers.
- The Safe chooses what to list. A listing does not prove quality, ownership of art or a future buyer.
- For every shop box: whoever picks the collections decides who can sell into a budget the fees pay for. Here that is the Safe.
- Gives spend the budget. Steady gives can keep the shop below its ceiling, and then the sellers' share keeps paying for gives instead of going to holders.
- A full shop only means its budget reached the ceiling, with fees counted.
- A give can wait for weekly room. A pick can fail if the item is gone or only the last item remains.
- Bugs, network costs and waiting fee steps can reduce or delay what reaches you. Check each action before signing.
- If the box fails, its remaining shop $TRASH is burned, not paid back to the Safe. Starter items go back to their creator.
- If the box fails, sellers' fees still waiting for the shop join the closing pot that holders claim from.

## Before use and counsel

This kit describes the Junkyard as the founder decided it. It does not certify a live contract.
The fees into the shop are new. Counsel must review them before launch.

Named picks only. You see the exact item you choose.
Paid random draws over existing NFTs stay out while they await counsel.
The founder cleared the earlier shop and holder model with counsel; that does not clear the fees into the shop or a new draw feature.
Public use still needs the right Terms and a check of the actual setup.
