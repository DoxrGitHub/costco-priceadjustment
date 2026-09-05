# Costco Price Adjustment

This is just a little script I whipped up to pull Costco Price Adjustment and structure valid price adjustment items in a table. Feel free to do whatever with it, as I do not expect to maintain this. This may not be fully accurate/faithful to Costco policy; use at your own risk!!

(Created with assistance from AI)

Please make sure to replace values in auth.json indicated in the file. To actually find those values, once authenticated, pull all values under `localStorage` in the browser for costco.com. You will need to read and find the Base64 values within the JSON within the localStorage objects under the item names that have "signin.costco.com" and then copy them accordingly to the auth.json... I'm aware these instructions aren't great but you'll get it.

Then, you can run `costco.js` through Bun/Node.js and it'll automatically try to use authentication (if idToken expires, it'll attempt to use the recovery token which lasts much longer) through the token manager.
