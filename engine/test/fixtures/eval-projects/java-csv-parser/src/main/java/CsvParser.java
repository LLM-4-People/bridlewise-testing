import java.util.ArrayList;
import java.util.List;

public class CsvParser {
    private final String delimiter;

    public CsvParser() {
        this(",");
    }

    public CsvParser(String delimiter) {
        this.delimiter = delimiter;
    }

    public List<String[]> parse(String line) {
        List<String[]> rows = new ArrayList<>();
        if (line == null || line.isEmpty()) {
            return rows;
        }
        String[] fields = line.split(delimiter);
        rows.add(fields);
        return rows;
    }

    public String[] parseRow(String row) {
        if (row == null || row.isEmpty()) {
            return new String[0];
        }
        return row.split(delimiter);
    }
}
