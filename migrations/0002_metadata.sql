INSERT INTO metadata(key, value) VALUES
  (
    'company',
    '{"name":"CÔNG TY CỔ PHẦN KODSDOOR VIỆT NAM","address":"Lô 20-LK19, khu đấu giá QSD Đất Mậu Lương, Kiến Hưng, Hà Nội","taxCode":"0108276927"}'
  ),
  (
    'settings',
    '{"allowNegative":true,"defaultWarehouse":"Kho công ty"}'
  ),
  (
    'source',
    'TEST KHO(5).xlsx / BaoCaoXuatNhapTon_KV03012026-09'
  ),
  (
    'seeded_at',
    '2026-07-18T02:32:32Z'
  )
ON CONFLICT(key) DO NOTHING;
