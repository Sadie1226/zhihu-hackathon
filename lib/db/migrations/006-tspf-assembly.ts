// Frozen v6: replace only validation triggers. The bootstrap transaction owns rollback.
export const TSPF_ASSEMBLY_V6_SQL = `
DROP TRIGGER IF EXISTS dog_assembly_ins;
DROP TRIGGER IF EXISTS dog_assembly_upd;
CREATE TRIGGER dog_assembly_ins BEFORE INSERT ON dog
BEGIN
  SELECT RAISE(ABORT, 'dog.assembly: invalid T/S/P/F') WHERE CASE
    WHEN typeof(NEW.assembly) <> 'text' OR instr(NEW.assembly, char(0)) > 0 OR json_valid(NEW.assembly) <> 1 THEN 1
    ELSE NOT COALESCE(
      json_type(NEW.assembly) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.assembly)) = 4
      AND json_type(NEW.assembly, '$.face') = 'text'
        AND json_extract(NEW.assembly, '$.face') IN ('F01-neutral', 'F02-wink', 'F03-teary', 'F04-smile', 'F05-unimpressed', 'F06-sparkle', 'F07-shiny', 'F08-sleepy', 'F10-closed-smile')
      AND (
        (json_type(NEW.assembly, '$.outfit') = 'text'
        AND json_extract(NEW.assembly, '$.outfit') IN ('T01-frog', 'T02-winter-post', 'T05-cloud-onesie', 'T06-starry-cloak', 'T07-striped-knit', 'T10-cowboy')
          AND json_type(NEW.assembly, '$.cloth') = 'null'
          AND json_type(NEW.assembly, '$.accessory') = 'null')
        OR (json_type(NEW.assembly, '$.outfit') = 'null'
          AND json_type(NEW.assembly, '$.cloth') = 'text'
        AND json_extract(NEW.assembly, '$.cloth') IN ('S01-yellow-cardigan', 'S02-leaf-cape', 'S03-apron', 'S04-olive-vest', 'S05-cream-vest', 'S06-navy-varsity', 'S07-blue-cloud-hoodie', 'S08-blue-check-pajamas', 'S09-seaside-shell-cape')
          AND (json_type(NEW.assembly, '$.accessory') = 'null' OR (json_type(NEW.assembly, '$.accessory') = 'text'
        AND json_extract(NEW.assembly, '$.accessory') IN ('P05-daisy-crown', 'P12-orange-thermos', 'P13-blue-cap', 'P15-star-bag', 'P16-mint-sunglasses', 'P19-blue-wings', 'P22-gold-round-glasses', 'P23-black-sunglasses', 'P25-blue-check-nightcap'))))
      ), 0)
  END;
END;

CREATE TRIGGER dog_assembly_upd BEFORE UPDATE OF assembly ON dog
BEGIN
  SELECT RAISE(ABORT, 'dog.assembly: invalid T/S/P/F') WHERE CASE
    WHEN typeof(NEW.assembly) <> 'text' OR instr(NEW.assembly, char(0)) > 0 OR json_valid(NEW.assembly) <> 1 THEN 1
    ELSE NOT COALESCE(
      json_type(NEW.assembly) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.assembly)) = 4
      AND json_type(NEW.assembly, '$.face') = 'text'
        AND json_extract(NEW.assembly, '$.face') IN ('F01-neutral', 'F02-wink', 'F03-teary', 'F04-smile', 'F05-unimpressed', 'F06-sparkle', 'F07-shiny', 'F08-sleepy', 'F10-closed-smile')
      AND (
        (json_type(NEW.assembly, '$.outfit') = 'text'
        AND json_extract(NEW.assembly, '$.outfit') IN ('T01-frog', 'T02-winter-post', 'T05-cloud-onesie', 'T06-starry-cloak', 'T07-striped-knit', 'T10-cowboy')
          AND json_type(NEW.assembly, '$.cloth') = 'null'
          AND json_type(NEW.assembly, '$.accessory') = 'null')
        OR (json_type(NEW.assembly, '$.outfit') = 'null'
          AND json_type(NEW.assembly, '$.cloth') = 'text'
        AND json_extract(NEW.assembly, '$.cloth') IN ('S01-yellow-cardigan', 'S02-leaf-cape', 'S03-apron', 'S04-olive-vest', 'S05-cream-vest', 'S06-navy-varsity', 'S07-blue-cloud-hoodie', 'S08-blue-check-pajamas', 'S09-seaside-shell-cape')
          AND (json_type(NEW.assembly, '$.accessory') = 'null' OR (json_type(NEW.assembly, '$.accessory') = 'text'
        AND json_extract(NEW.assembly, '$.accessory') IN ('P05-daisy-crown', 'P12-orange-thermos', 'P13-blue-cap', 'P15-star-bag', 'P16-mint-sunglasses', 'P19-blue-wings', 'P22-gold-round-glasses', 'P23-black-sunglasses', 'P25-blue-check-nightcap'))))
      ), 0)
  END;
END;
`
