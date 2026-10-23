import sys,unittest
from unittest.mock import patch,MagicMock
sys.path.insert(0,'examples/local_rendering')
from kartatai import generate_link,listing_fields
class ProviderTests(unittest.TestCase):
 def test_modes(self):
  ad={'title':'Jacket','seller':{'name':'Seller','avatar_url':'https://example.com/avatar.png'},'image_url':'https://example.com/item.png','price':'12,50','currency':'AUD','geo':'AU'}
  for mode,title,photo,category in [('2.0','Jacket',ad['image_url'],'depop_eu'),('verif','Seller',ad['seller']['avatar_url'],'depop3_usa')]:
   config=dict(mode=mode,serviceCode='Depop',apiKey='test',userId='123',endpoint='https://example.com',buyerName='Buyer',buyerAddress='Address')
   with patch('kartatai.requests.Session') as factory:
    client=factory.return_value.__enter__.return_value
    client.post.return_value.json.return_value={'message':'https://example.com/generated'}
    self.assertEqual(generate_link(config,ad),'https://example.com/generated')
    payload=client.post.call_args.kwargs['json']
    self.assertEqual((payload['title'],payload['photo'],payload['price'],payload['service']),(title,photo,'12.50 AUD',category))
    self.assertEqual(payload['name'],'Buyer')
 def test_missing_seller(self):
  with self.assertRaises(ValueError): listing_fields({'mode':'verif'},{'title':'Item'})
 def test_currency_from_geo(self):
  self.assertEqual(listing_fields({'mode':'2.0','selectedGeos':['GB']},{'title':'Item','price':'10'})['price'],'10.00 GBP')
 def test_verif_without_price(self):
  self.assertIsNone(listing_fields({'mode':'verif'},{'name':'Seller'})['price'])
unittest.main()
