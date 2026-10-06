package com.duipai.service;

import java.util.Map;

public final class Templates {
    private Templates() { }

    public static final String STATEMENT = """
            # 数组求和（示例）

            给定 $n$ 个整数，输出它们的和。此示例可以直接开始对拍。

            ## 输入格式
            第一行是整数 $n$，第二行是 $n$ 个整数。

            ## 输出格式
            输出一个整数，表示所有元素之和。

            ## 样例
            ```text
            3
            1 2 3
            ```
            输出 `6`。

            生成器通过 `args[0]` 接收种子。三个编辑器中的程序都应为 `public class Main`。
            """;

    public static Map<String, String> codes() {
        return Map.of("generator", GENERATOR, "brute", BRUTE, "optimized", OPTIMIZED);
    }

    public static final String GENERATOR = """
            import java.util.Random;

            public class Main {
                public static void main(String[] args) {
                    long seed = Long.parseLong(args[0]);
                    Random random = new Random(seed);
                    int n = 1 + random.nextInt(100);
                    System.out.println(n);
                    for (int i = 0; i < n; i++) {
                        if (i > 0) System.out.print(" ");
                        System.out.print(random.nextInt(2001) - 1000);
                    }
                    System.out.println();
                }
            }
            """;

    public static final String BRUTE = """
            import java.util.Scanner;

            public class Main {
                public static void main(String[] args) {
                    Scanner in = new Scanner(System.in);
                    int n = in.nextInt();
                    long sum = 0;
                    for (int i = 0; i < n; i++) sum += in.nextLong();
                    System.out.println(sum);
                }
            }
            """;

    public static final String OPTIMIZED = """
            import java.io.BufferedInputStream;
            import java.io.IOException;

            public class Main {
                private static final BufferedInputStream IN = new BufferedInputStream(System.in);
                private static long nextLong() throws IOException {
                    int c;
                    do { c = IN.read(); } while (c >= 0 && c <= 32);
                    if (c < 0) throw new IOException("Unexpected end of input");
                    int sign = 1;
                    if (c == '-') { sign = -1; c = IN.read(); }
                    long value = 0;
                    while (c > 32 && c >= 0) { value = value * 10 + c - '0'; c = IN.read(); }
                    return sign * value;
                }
                public static void main(String[] args) throws Exception {
                    int n = (int) nextLong();
                    long sum = 0;
                    for (int i = 0; i < n; i++) sum += nextLong();
                    System.out.println(sum);
                }
            }
            """;
}
