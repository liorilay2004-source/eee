"""Convert a freshly observed official EL AL fare snapshot to bounded D1 SQL.

Usage: python scripts/import-elal-snapshot.py snapshot.json output.sql
Snapshot: {checkedAt: ISO timestamp, fares: [exact dated public fare records]}.
No keys, browser cookies or private customer data belong in this input.
"""
import datetime as dt
import json
import pathlib
import sys

def build_sql(snapshot, now):
    checked = dt.datetime.fromisoformat(snapshot['checkedAt'].replace('Z', '+00:00'))
    if checked.tzinfo is None or not 0 <= (now - checked).total_seconds() <= 3600:
        raise ValueError('Snapshot must have an explicit UTC offset and be less than one hour old')
    fares = snapshot['fares']
    if not isinstance(fares, list) or not 1 <= len(fares) <= 100:
        raise ValueError('Expected 1–100 observed fares')
    def sql(value):
        return "'" + str(value).replace("'", "''") + "'"
    leg = json.dumps(dict(departTime=None, arriveTime=None, stops=None, durationMin=None, airlines=['LY']))
    legs = '{"outbound":' + leg + ',"inbound":' + leg + '}'
    statements = []
    for f in fares:
        if f['airline'] != 'LY' or f['origin'] != 'TLV' or f['sourceUrl'] != 'https://www.elal.com/flight-deals/en-il/' or f['pricing'] != 'published_advertisement':
            raise ValueError('Only observed official EL AL TLV advertisements are supported')
        if len(f['destination']) != 3 or not f['destination'].isascii() or not f['destination'].isupper() or not f['destination'].isalpha():
            raise ValueError('Invalid destination')
        depart, back = dt.date.fromisoformat(f['departDate']), dt.date.fromisoformat(f['returnDate'])
        if depart < now.date() or back <= depart or f['currency'] != 'USD' or type(f['amount']) not in (int, float) or not 0 < f['amount'] < 100000:
            raise ValueError('Invalid exact dates or cash price')
        values = [f['origin'], f['destination'], f['departDate'], f['returnDate'], f['amount'], f['currency'], 'elal', 'roundtrip', '["LY"]', legs, '{}', f['sourceUrl'], f['sourceUrl'], checked.isoformat()]
        statements.append('INSERT INTO prices (origin,destination,depart_date,return_date,price_amount,price_currency,source,ticket_structure,airlines_json,legs_json,includes_json,deeplink,verify_link,checked_at) VALUES (' + ','.join(sql(v) for v in values) + ');')
    return '\n'.join(statements) + '\n'

if __name__ == '__main__':
    snapshot = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
    pathlib.Path(sys.argv[2]).write_text(build_sql(snapshot, dt.datetime.now(dt.timezone.utc)), encoding='utf-8')
