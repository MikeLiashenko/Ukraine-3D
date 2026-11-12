import osmium, sys, time, collections, json
t0 = time.time()
c = collections.Counter(); places = collections.Counter(); adm = collections.Counter()
for o in osmium.FileProcessor(sys.argv[1]):
    t = o.tags
    if o.is_node():
        c['nodes'] += 1
        if 'place' in t and 'name' in t: places[t['place']] += 1
    elif o.is_way():
        c['ways'] += 1
        if 'building' in t: c['bld_way'] += 1
        if 'building:part' in t: c['part'] += 1
        if 'highway' in t: c['hw'] += 1
    else:
        c['rels'] += 1
        if 'building' in t: c['bld_rel'] += 1
        if t.get('boundary') == 'administrative': adm[t.get('admin_level', '?')] += 1
        if 'place' in t and 'name' in t: places['rel_' + t['place']] += 1
print(dict(c)); print(dict(places)); print(dict(adm)); print(f'{time.time()-t0:.0f}s')
